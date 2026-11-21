declare const router: any;
declare const tracer: any;
declare const logger: any;
declare const chargeCustomer: (id: string, amount: number) => Promise<void>;
declare const lookupBalance: (id: string) => Promise<number>;

router.get('/healthz', (_req: any, res: any) => res.json({ ok: true }));

router.post('/v1/charges', async (req: any, res: any) => {
  const { customerId, amount } = req.body;
  await chargeCustomer(customerId, amount);
  res.status(201).json({ status: 'charged' });
});

router.get('/v1/balances/:id', async (req: any, res: any) => {
  return tracer.startActiveSpan('balances.lookup', async (span: any) => {
    try {
      const balance = await lookupBalance(req.params.id);
      span.setAttribute('customer.id', req.params.id);
      res.json({ balance });
    } catch (err) {
      span.recordException(err);
      logger.error({ err }, 'balance lookup failed');
      res.status(500).json({ error: 'internal' });
    } finally {
      span.end();
    }
  });
});
