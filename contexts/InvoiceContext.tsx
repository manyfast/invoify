"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";

import { useRouter } from "next/navigation";

// Next Intl
import { useLocale } from "next-intl";

// RHF
import { useFormContext } from "react-hook-form";

// Hooks
import useToasts from "@/hooks/useToasts";

// Services
import { exportInvoice } from "@/services/invoice/client/exportInvoice";

// Validation
import { InvoiceSchema } from "@/lib/schemas";

// Helpers
import { nextInvoiceNumber } from "@/lib/invoiceNumber";

// Variables
import {
  FORM_DEFAULT_VALUES,
  GENERATE_PDF_API,
  SHORT_DATE_OPTIONS,
  LOCAL_STORAGE_INVOICE_DRAFT_KEY,
  WARM_BROWSER_API,
} from "@/lib/variables";

// Storage
import { readSecure, removeSecure, writeSecure } from "@/lib/secureStore";

// Types
import { ExportTypes, InvoiceType } from "@/types";

/**
 * Unprefixed, unlike the newer invoify: keys — this one predates that
 * namespace and renaming it would orphan every invoice anyone has saved.
 */
const SAVED_INVOICES_KEY = "savedInvoices";

const defaultInvoiceContext = {
  invoicePdf: new Blob(),
  invoicePdfLoading: false,
  savedInvoices: [] as InvoiceType[],
  pdfUrl: null as string | null,
  onFormSubmit: (values: InvoiceType) => {},
  newInvoice: () => {},
  generatePdf: async (data: InvoiceType) => {},
  removeFinalPdf: () => {},
  downloadPdf: () => {},
  printPdf: () => {},
  previewPdfInTab: () => {},
  saveInvoice: () => {},
  deleteInvoice: (index: number) => {},
  exportInvoiceAs: (exportAs: ExportTypes) => {},
};

export const InvoiceContext = createContext(defaultInvoiceContext);

export const useInvoiceContext = () => {
  return useContext(InvoiceContext);
};

type InvoiceContextProviderProps = {
  children: React.ReactNode;
};

export const InvoiceContextProvider = ({
  children,
}: InvoiceContextProviderProps) => {
  const router = useRouter();
  const locale = useLocale();

  // Toasts
  const {
    newInvoiceSuccess,
    pdfGenerationSuccess,
    saveInvoiceSuccess,
    modifiedInvoiceSuccess,
    pdfGenerationError,
    exportInvoiceError,
  } = useToasts();

  // Get form values and methods from form context
  const { getValues, reset, watch } = useFormContext<InvoiceType>();

  // Variables
  const [invoicePdf, setInvoicePdf] = useState<Blob>(new Blob());
  const [invoicePdfLoading, setInvoicePdfLoading] = useState<boolean>(false);

  // Lets a new PDF request cancel the one it supersedes
  const generateAbortRef = useRef<AbortController | null>(null);

  // Saved invoices
  const [savedInvoices, setSavedInvoices] = useState<InvoiceType[]>([]);

  useEffect(() => {
    let active = true;
    // Encrypted at rest, so this is a promise now. The guard keeps a late
    // resolve from writing into an unmounted provider.
    readSecure<InvoiceType[]>(SAVED_INVOICES_KEY).then((saved) => {
      if (active) setSavedInvoices(Array.isArray(saved) ? saved : []);
    });
    return () => {
      active = false;
    };
  }, []);

  /*
   * Warm the PDF renderer.
   *
   * Chromium takes roughly 2.3s to launch, and on a cold serverless instance
   * the user paid all of it on their first Generate. Kicking the launch off
   * now overlaps it with filling in the form.
   *
   * Deliberately fire-and-forget: the result is ignored, and a failure leaves
   * generation to launch the browser itself exactly as before.
   */
  useEffect(() => {
    const controller = new AbortController();
    fetch(WARM_BROWSER_API, { signal: controller.signal }).catch(() => {});
    return () => controller.abort();
  }, []);


  /*
   * Editing returns you to the live preview.
   *
   * The preview column switches on `invoicePdf.size`, so once a PDF existed the
   * user was stuck looking at it: the only ways back were a "Back to live
   * preview" button in the corner and resetting the whole form. Generating was
   * effectively a mode you had to know how to leave, which is what made the two
   * preview surfaces confusing.
   *
   * Now the first edit after a generation drops the PDF. Generating becomes an
   * action with a result rather than a state you enter.
   */
  useEffect(() => {
    if (invoicePdf.size === 0) return;

    const subscription = watch((_value, { type }) => {
      // `type` is undefined for programmatic reset()/setValue() calls made
      // during hydration; only a real user change should discard the PDF.
      if (type === "change") setInvoicePdf(new Blob());
    });

    return () => subscription.unsubscribe();
  }, [invoicePdf.size, watch]);

  /*
   * Object URL for the generated PDF.
   *
   * This was a `useMemo` that created a URL and never revoked it, so every
   * generation leaked the whole PDF for the lifetime of the page. Held in
   * state instead, with the previous URL revoked on replace and on unmount.
   */
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);

  useEffect(() => {
    if (invoicePdf.size === 0) {
      setPdfUrl(null);
      return;
    }

    const url = window.URL.createObjectURL(invoicePdf);
    setPdfUrl(url);

    return () => window.URL.revokeObjectURL(url);
  }, [invoicePdf]);

  /**
   * Handles form submission.
   *
   * @param {InvoiceType} data - The form values used to generate the PDF.
   */
  const onFormSubmit = (data: InvoiceType) => {
    // Call generate pdf method
    generatePdf(data);
  };

  /**
   * Generates a new invoice.
   */
  const newInvoice = () => {
    /*
     * Suggest the next number rather than leaving the field blank.
     *
     * Derived from the most recent saved invoice, preserving whatever scheme
     * it used — INV0007 -> INV0008, 2026-14 -> 2026-15. It is only a
     * suggestion: the field stays a normal editable input, because an invoice
     * number is a legal identifier and people have their own conventions.
     */
    reset({
      ...FORM_DEFAULT_VALUES,
      details: {
        ...FORM_DEFAULT_VALUES.details,
        invoiceNumber: nextInvoiceNumber(savedInvoices),
      },
    });
    setInvoicePdf(new Blob());

    // Clear the draft
    void removeSecure(LOCAL_STORAGE_INVOICE_DRAFT_KEY);

    router.refresh();

    // Toast
    newInvoiceSuccess();
  };

  /**
   * Generate a PDF document based on the provided data.
   *
   * @param {InvoiceType} data - The data used to generate the PDF.
   * @returns {Promise<void>} - A promise that resolves when the PDF is successfully generated.
   * @throws {Error} - If an error occurs during the PDF generation process.
   */
  const generatePdf = useCallback(async (data: InvoiceType) => {
    // Cancel any in-flight generation so a re-submit doesn't race the previous
    // one and resolve out of order.
    generateAbortRef.current?.abort();
    const controller = new AbortController();
    generateAbortRef.current = controller;

    setInvoicePdfLoading(true);

    try {
      // Locale travels as a query param so the server can render the PDF in
      // the same language as the UI.
      const response = await fetch(`${GENERATE_PDF_API}?locale=${locale}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: controller.signal,
      });

      /*
       * Without this check an error response was read as a PDF blob and, since
       * the JSON error body has a non-zero size, reported to the user as a
       * successful generation.
       */
      if (!response.ok) {
        throw new Error(
          `PDF generation failed with status ${response.status}`,
        );
      }

      const result = await response.blob();
      setInvoicePdf(result);

      if (result.size > 0) {
        // Toast
        pdfGenerationSuccess();
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") {
        // Superseded by a newer submit; the newer one owns the loading state.
        return;
      }
      console.error(err);
      pdfGenerationError();
    } finally {
      if (generateAbortRef.current === controller) {
        generateAbortRef.current = null;
        setInvoicePdfLoading(false);
      }
    }
  }, [locale]);

  /**
   * Removes the final PDF file and switches to Live Preview
   */
  const removeFinalPdf = () => {
    setInvoicePdf(new Blob());
  };

  /**
   * Generates a preview of a PDF file and opens it in a new browser tab.
   */
  const previewPdfInTab = () => {
    // Reuses the managed URL rather than minting a second one. The previous
    // version created a fresh object URL per click and never revoked it —
    // revoking here is not an option either, since the new tab still needs it.
    if (pdfUrl) {
      window.open(pdfUrl, "_blank");
    }
  };

  /**
   * Downloads a PDF file.
   */
  const downloadPdf = () => {
    // Only download if there is an invoice
    if (invoicePdf instanceof Blob && invoicePdf.size > 0) {
      // Create a blob URL to trigger the download
      const url = window.URL.createObjectURL(invoicePdf);

      // Create an anchor element to initiate the download
      const a = document.createElement("a");
      a.href = url;
      a.download = "invoice.pdf";
      document.body.appendChild(a);

      // Trigger the download
      a.click();

      // Clean up the URL object
      window.URL.revokeObjectURL(url);
    }
  };

  /**
   * Prints a PDF file.
   */
  const printPdf = () => {
    if (pdfUrl) {
      const printWindow = window.open(pdfUrl, "_blank");
      if (printWindow) {
        printWindow.onload = () => {
          printWindow.print();
        };
      }
    }
  };

  // TODO: Change function name. (saveInvoiceData maybe?)
  /**
   * Saves the invoice data to local storage.
   */
  const saveInvoice = async () => {
    if (invoicePdf) {
      // If get values function is provided, allow to save the invoice
      if (getValues) {
        // Retrieve the existing array from storage or initialize an empty array
        const stored = await readSecure<InvoiceType[]>(SAVED_INVOICES_KEY);
        const savedInvoices: InvoiceType[] = Array.isArray(stored)
          ? stored
          : [];

        const updatedDate = new Date().toLocaleDateString(
          "en-US",
          SHORT_DATE_OPTIONS
        );

        const formValues = getValues();
        formValues.details.updatedAt = updatedDate;

        const existingInvoiceIndex = savedInvoices.findIndex(
          (invoice: InvoiceType) => {
            return (
              invoice.details.invoiceNumber === formValues.details.invoiceNumber
            );
          }
        );

        // If invoice already exists
        if (existingInvoiceIndex !== -1) {
          savedInvoices[existingInvoiceIndex] = formValues;

          // Toast
          modifiedInvoiceSuccess();
        } else {
          // Add the form values to the array
          savedInvoices.push(formValues);

          // Toast
          saveInvoiceSuccess();
        }

        await writeSecure(SAVED_INVOICES_KEY, savedInvoices);

        setSavedInvoices(savedInvoices);
      }
    }
  };

  // TODO: Change function name. (deleteInvoiceData maybe?)
  /**
   * Delete an invoice from local storage based on the given index.
   *
   * @param {number} index - The index of the invoice to be deleted.
   */
  const deleteInvoice = (index: number) => {
    if (index >= 0 && index < savedInvoices.length) {
      const updatedInvoices = [...savedInvoices];
      updatedInvoices.splice(index, 1);
      setSavedInvoices(updatedInvoices);

      void writeSecure(SAVED_INVOICES_KEY, updatedInvoices);
    }
  };

  /**
   * Export an invoice in the specified format using the provided form values.
   *
   * This function initiates the export process with the chosen export format and the form data.
   *
   * @param {ExportTypes} exportAs - The format in which to export the invoice.
   */
  const exportInvoiceAs = (exportAs: ExportTypes) => {
    const formValues = getValues();

    // Service to export invoice with given parameters
    exportInvoice(exportAs, formValues).catch((error) => {
      console.error("Error exporting invoice:", error);
      exportInvoiceError();
    });
  };


  return (
    <InvoiceContext.Provider
      value={{
        invoicePdf,
        invoicePdfLoading,
        savedInvoices,
        pdfUrl,
        onFormSubmit,
        newInvoice,
        generatePdf,
        removeFinalPdf,
        downloadPdf,
        printPdf,
        previewPdfInTab,
        saveInvoice,
        deleteInvoice,
        exportInvoiceAs,
      }}
    >
      {children}
    </InvoiceContext.Provider>
  );
};
