declare const Worker: any;
declare const generateInvoicePdf: (id: string) => Promise<Buffer>;
declare const sendWebhook: (url: string, payload: unknown) => Promise<void>;

new Worker('invoice-generation', async (job: any) => {
  const pdf = await generateInvoicePdf(job.data.invoiceId);
  try {
    await sendWebhook(job.data.webhookUrl, { bytes: pdf.length });
  } catch (err) {

    return { delivered: false };
  }
  return { delivered: true };
});
