import axios, { AxiosError } from 'axios';

export const TOKEN_KEY = 'erp_token';

export const api = axios.create({
  baseURL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api',
});

// Attach JWT from localStorage on every request.
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// On 401, clear token and bounce to login.
api.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      localStorage.removeItem(TOKEN_KEY);
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  },
);

/** Standard API error shape from the NestJS exception filter. */
export interface ApiError {
  message: string;
  errors?: Record<string, string>;
}

export function getApiError(error: unknown): ApiError {
  const err = error as AxiosError<{ message?: string; errors?: Record<string, string> }>;
  return {
    message: err.response?.data?.message ?? 'Something went wrong.',
    errors: err.response?.data?.errors,
  };
}

/** Unwrap the { success, data } envelope. */
export async function unwrap<T>(promise: Promise<{ data: { data: T } }>): Promise<T> {
  const res = await promise;
  return res.data.data;
}

// ---- Endpoint helpers ----
export const Api = {
  login: (login: string, password: string) =>
    unwrap<{ token: string; user: any }>(api.post('/auth/login', { login, password })),
  me: () => unwrap<any>(api.get('/auth/me')),

  processes: () => unwrap<any[]>(api.get('/processes')),
  createService: (body: { name: string; appliesTo?: string }) =>
    unwrap<any>(api.post('/processes/services', body)),
  createProcess: (body: any) => unwrap<any>(api.post('/processes', body)),
  updateProcess: (id: number, body: any) => unwrap<any>(api.put(`/processes/${id}`, body)),
  deleteProcess: (id: number) => unwrap<any>(api.delete(`/processes/${id}`)),

  dashboard: () => unwrap<any>(api.get('/dashboard')),

  vendors: {
    list: (params?: Record<string, any>) => unwrap<any[]>(api.get('/vendors', { params })),
    get: (id: number) => unwrap<any>(api.get(`/vendors/${id}`)),
    create: (body: any) => unwrap<any>(api.post('/vendors', body)),
    update: (id: number, body: any) => unwrap<any>(api.put(`/vendors/${id}`, body)),
    remove: (id: number) => unwrap<any>(api.delete(`/vendors/${id}`)),
  },

  materials: {
    categories: () => unwrap<any[]>(api.get('/materials/categories')),
    createCategory: (name: string) =>
      unwrap<{ id: number; name: string }>(api.post('/materials/categories', { name })),
    list: () => unwrap<any[]>(api.get('/materials/list')),
    variants: (params?: Record<string, any>) =>
      unwrap<any[]>(api.get('/materials/variants', { params })),
    getVariant: (id: number) => unwrap<any>(api.get(`/materials/variants/${id}`)),
    createVariant: (body: any) => unwrap<any>(api.post('/materials/variants', body)),
    // Bulk-create N colour variants from one shared base. See backend
    // /materials/variants/bulk-colors — single transaction, all-or-nothing.
    bulkCreateColorVariants: (body: {
      materialName: string;
      categoryId?: number;
      size?: string;
      finish?: string;
      shape?: string;
      unit?: string;
      notes?: string;
      trackByQty?: boolean;
      trackByWeight?: boolean;
      vendorId: number;
      vendorReference?: string;
      moq?: number;
      vendorNotes?: string;
      colors: Array<{ color: string; price?: number; initialStock?: number; initialStockWeight?: number; imagePath?: string }>;
    }) => unwrap<{ created: Array<{ id: number; variantCode: string; color: string }> }>(
      api.post('/materials/variants/bulk-colors', body),
    ),
    updateVariant: (id: number, body: any) =>
      unwrap<any>(api.put(`/materials/variants/${id}`, body)),
    removeVariant: (id: number) => unwrap<any>(api.delete(`/materials/variants/${id}`)),
    setVariantStatus: (id: number, status: 'ACTIVE' | 'INACTIVE') =>
      unwrap<{ id: number; status: 'ACTIVE' | 'INACTIVE' }>(
        api.put(`/materials/variants/${id}/status`, { status }),
      ),
    // Inventory
    stock: (search?: string) => unwrap<any[]>(api.get('/materials/stock', { params: { search } })),
    movements: (variantId?: number) => unwrap<any[]>(api.get('/materials/stock/movements', { params: { variantId } })),
    purchaseReceipts: () => unwrap<any[]>(api.get('/materials/purchase-receipts')),
    adjustStock: (
      variantId: number,
      body: {
        type: string;
        quantity?: number;
        weight?: number;
        note?: string;
        vendorId?: number | null;
        invoiceNumber?: string | null;
        unitPrice?: number | null;
        unitRatePerGram?: number | null;
      },
    ) => unwrap<any>(api.post(`/materials/variants/${variantId}/stock`, body)),
  },

  items: {
    meta: () => unwrap<any>(api.get('/items/meta')),
    lookups: () =>
      unwrap<{ categories: string[]; subcategories: string[]; collections: string[] }>(
        api.get('/items/lookups'),
      ),
    nextDesignCode: (shortName?: string) =>
      unwrap<{ sampleDesignCode: string }>(api.get('/items/next-design-code', { params: { shortName } })),
    nextItemNumber: () =>
      unwrap<{ itemNumber: string }>(api.get('/items/next-item-number')),
    allocateItemNumber: (id: number, itemNumber: string) =>
      unwrap<{ id: number; itemNumber: string }>(api.post(`/items/${id}/allocate-item-number`, { itemNumber })),
    // Missing-parts surface — list + recast trigger.
    listMissingParts: (id: number) =>
      unwrap<any[]>(api.get(`/items/${id}/missing-parts`)),
    recastMissingParts: (id: number, body: { vendorId: number; missingPartIds: number[]; castingDate?: string; notes?: string }) =>
      unwrap<{ batchId: number; batchNumber: string; rows: { id: number; partName: string }[] }>(
        api.post(`/items/${id}/recast-missing-parts`, body),
      ),
    list: (params?: Record<string, any>) => unwrap<any[]>(api.get('/items', { params })),
    get: (id: number) => unwrap<any>(api.get(`/items/${id}`)),
    create: (body: any) => unwrap<any>(api.post('/items', body)),
    update: (id: number, body: any) => unwrap<any>(api.put(`/items/${id}`, body)),
    remove: (id: number) => unwrap<any>(api.delete(`/items/${id}`)),
    deleteImage: (id: number, imageId: number) =>
      unwrap<any>(api.delete(`/items/${id}/images/${imageId}`)),
    // Surgical rate setter — used by the Undo button on rate-sync toasts
    // fired from batch creation / forward. Passing rate=null clears the
    // master rate (sets the field back to "no rate"). Backend recomputes
    // item.costPrice after the change and returns the new value.
    setProcessRate: (id: number, processId: number, body: { vendorId?: number; rate: number | null }) =>
      unwrap<{ updated: boolean; costPrice: number }>(
        api.put(`/items/${id}/processes/${processId}/rate`, body),
      ),
    // Printable blank datasheet — design photo on top, blank form below
    // for handwritten field collection. Returns the absolute URL for a
    // new-tab open (no Authorization header needed; route is @Public).
    // The trailing `<itemNumber>_details.pdf` segment is purely cosmetic
    // — backend resolves the item by :id — but it sets the browser's
    // default Save As filename to `<itemNumber>_details.pdf` instead of
    // the generic `datasheet.pdf`. Falls back to the id when itemNumber
    // is missing (draft items).
    datasheetPdfUrl: (id: number, itemNumber?: string | null) => {
      const base = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api';
      const slug = (itemNumber ?? String(id)).replace(/[^A-Za-z0-9._-]+/g, '_');
      return `${base}/items/${id}/datasheet/${slug}_details.pdf`;
    },
  },

  users: {
    list: (params?: { search?: string; role?: string; status?: string }) =>
      unwrap<any[]>(api.get('/users', { params })),
    get: (id: number) => unwrap<any>(api.get(`/users/${id}`)),
    create: (body: { username: string; email: string; fullName: string; password: string; role?: string; status?: string }) =>
      unwrap<any>(api.post('/users', body)),
    update: (id: number, body: { email?: string; fullName?: string; role?: string; status?: string }) =>
      unwrap<any>(api.put(`/users/${id}`, body)),
    resetPassword: (id: number, password: string) =>
      unwrap<{ id: number; ok: boolean }>(api.post(`/users/${id}/password`, { password })),
    remove: (id: number) => unwrap<{ id: number }>(api.delete(`/users/${id}`)),
  },

  vendorAdvances: {
    balances: (vendorId?: number) =>
      unwrap<any[]>(api.get('/vendor-advances/balances', { params: { vendorId } })),
    ledger: (params?: { vendorId?: number; variantId?: number; limit?: number }) =>
      unwrap<any[]>(api.get('/vendor-advances/ledger', { params })),
    allocate: (body: { vendorId: number; variantId: number; weight: number; note?: string; sourceLotId?: number }) =>
      unwrap<{ id: number; ledgerId: number; balanceWeight: number; sourceLotId?: number | null }>(
        api.post('/vendor-advances/allocate', body),
      ),
    returnFromVendor: (body: { vendorId: number; variantId: number; weight: number; note?: string; sourceLotId?: number }) =>
      unwrap<{ ledgerId: number; balanceWeight: number }>(
        api.post('/vendor-advances/return', body),
      ),
    adjust: (body: { vendorId: number; variantId: number; weight: number; note: string }) =>
      unwrap<{ ledgerId: number; balanceWeight: number }>(
        api.post('/vendor-advances/adjust', body),
      ),
    updateLedger: (id: number, body: { weight: number; note?: string }) =>
      unwrap<any>(api.put(`/vendor-advances/ledger/${id}`, body)),
    deleteLedger: (id: number) =>
      unwrap<{ id: number; balanceAfter: number }>(api.delete(`/vendor-advances/ledger/${id}`)),
  },

  customerAdvances: {
    balances: (customerId?: number) =>
      unwrap<any[]>(api.get('/customer-advances/balances', { params: { customerId } })),
    ledger: (params?: { customerId?: number; variantId?: number; eventType?: string; limit?: number }) =>
      unwrap<any[]>(api.get('/customer-advances/ledger', { params })),
    summary: (customerId: number) =>
      unwrap<{
        customer: { id: number; customerCode: string; customerName: string };
        totals: {
          totalMetalReceived: number; totalMetalGiven: number;
          totalLabourGiven: number;  totalLabourReceived: number;
          labourBalance: number;
        };
        metalBalances: any[];
      }>(api.get(`/customer-advances/${customerId}/summary`)),
    metalLedgerFull: (customerId: number) =>
      unwrap<{
        customer: { id: number; customerCode: string; customerName: string };
        lots: any[];
        issuances: any[];
        holdings: any[];
        draws: any[];
        totals: { lotsIn: number; remainingInLots: number; atVendors: number; soldToCustomer: number; unreconciled: number };
      }>(api.get(`/customer-advances/${customerId}/metal-ledger-full`)),
    allocate: (body: { customerId: number; variantId: number; weight: number; note?: string }) =>
      unwrap<{ id: number; ledgerId: number; balanceWeight: number }>(
        api.post('/customer-advances/allocate', body),
      ),
    returnToCustomer: (body: { customerId: number; variantId: number; weight: number; note?: string }) =>
      unwrap<{ ledgerId: number; balanceWeight: number }>(
        api.post('/customer-advances/return', body),
      ),
    labourGiven: (body: { customerId: number; amount: number; refType?: string; refId?: number; note?: string }) =>
      unwrap<{ id: number }>(api.post('/customer-advances/labour-given', body)),
    labourReceived: (body: { customerId: number; amount: number; refType?: string; refId?: number; note?: string }) =>
      unwrap<{ id: number }>(api.post('/customer-advances/labour-received', body)),
    adjust: (body: { customerId: number; variantId: number; weight: number; note: string }) =>
      unwrap<{ ledgerId: number; balanceWeight: number }>(
        api.post('/customer-advances/adjust', body),
      ),
    deleteLedger: (id: number) =>
      unwrap<{ id: number }>(api.delete(`/customer-advances/ledger/${id}`)),
  },

  alloying: {
    list: () => unwrap<any[]>(api.get('/alloying')),
    findOne: (id: number) => unwrap<any>(api.get(`/alloying/${id}`)),
    create: (body: { batchDate: string; notes?: string }) =>
      unwrap<any>(api.post('/alloying', body)),
    saveLines: (
      id: number,
      body: {
        inputs: Array<{ variantId: number; weightG: number; notes?: string }>;
        outputs: Array<{ kind: 'ALLOY' | 'RUNNERS' | 'LOSS'; variantId?: number; weightG: number; notes?: string }>;
      },
    ) => unwrap<any>(api.put(`/alloying/${id}/lines`, body)),
    melt: (id: number) => unwrap<any>(api.post(`/alloying/${id}/melt`, {})),
    cancel: (id: number) => unwrap<any>(api.delete(`/alloying/${id}`)),
    hardDelete: (id: number) =>
      unwrap<{ id: number; batchNumber: string }>(api.delete(`/alloying/${id}/hard`)),
  },

  silverLots: {
    list: (params?: {
      customerId?: number;
      source?: 'BULLION' | 'CUSTOMER_ADVANCE';
      variantId?: number;
      hasRemaining?: boolean;
    }) =>
      unwrap<any[]>(api.get('/silver-lots', { params })),
    create: (body: {
      source: 'BULLION' | 'CUSTOMER_ADVANCE';
      rateType: 'FIX' | 'UNFIX';
      variantId: number;
      vendorId?: number;
      customerId?: number;
      receivedAt?: string;
      receivedWeightG: number;
      ratePerG: number;
      billNumber?: string;
      notes?: string;
    }) =>
      unwrap<any>(api.post('/silver-lots', body)),
    previewDraw: (params: { customerId?: number; variantId: number; weightG: number }) =>
      unwrap<{ draws: any[]; remainingUnfilled: number }>(
        api.get('/silver-lots/preview-draw', { params }),
      ),
    update: (id: number, body: {
      rateType?: 'FIX' | 'UNFIX';
      receivedAt?: string;
      ratePerG?: number;
      billNumber?: string;
      notes?: string;
    }) => unwrap<any>(api.put(`/silver-lots/${id}`, body)),
    delete: (id: number) =>
      unwrap<{ id: number; lotNumber: string }>(api.delete(`/silver-lots/${id}`)),
  },

  reports: {
    lossGain: (params: { from?: string; to?: string; processId?: number; vendorId?: number }) =>
      unwrap<{ rows: any[]; totals: any }>(api.get('/reports/loss-gain', { params })),
    stones: (params: { from?: string; to?: string }) =>
      unwrap<{ rows: any[]; totals: any }>(api.get('/reports/stones', { params })),
    vendorMetal: () =>
      unwrap<{ rows: any[]; totalAdvance: number }>(api.get('/reports/vendor-metal')),
    perDesign: (params: { from?: string; to?: string }) =>
      unwrap<{ rows: any[] }>(api.get('/reports/per-design', { params })),
  },

  audit: {
    list: (params?: { userId?: number; action?: string; actionPrefix?: string; targetType?: string; targetId?: number; search?: string; from?: string; to?: string; limit?: number; cursor?: number }) =>
      unwrap<{ items: any[]; nextCursor: number | null }>(
        api.get('/audit/logs', { params }),
      ),
    undoStrategies: () =>
      unwrap<{ strategies: string[] }>(api.get('/audit/undo-strategies')),
    undo: (id: number) =>
      unwrap<{ id: number; undoneAt: string }>(api.post(`/audit/logs/${id}/undo`, {})),
  },

  casting: {
    nextBatchNumber: () => unwrap<{ batchNumber: string }>(api.get('/casting/next-batch-number')),
    batches: (params?: Record<string, any>) => unwrap<any[]>(api.get('/casting/batches', { params })),
    batch: (id: number) => unwrap<any>(api.get(`/casting/batches/${id}`)),
    batchVendors: (id: number) => unwrap<any[]>(api.get(`/casting/batches/${id}/vendors`)),
    createBatch: (body: any) => unwrap<any>(api.post('/casting/batches', body)),
    updateBatch: (id: number, body: any) => unwrap<any>(api.put(`/casting/batches/${id}`, body)),
    removeBatch: (id: number) => unwrap<any>(api.delete(`/casting/batches/${id}`)),
    pending: (batchId: number, vendorId: number, editReceiptId?: number | null) =>
      unwrap<any>(api.get(`/casting/batches/${batchId}/pending/${vendorId}`, {
        params: editReceiptId ? { editReceiptId } : undefined,
      })),
    receipts: (params?: Record<string, any>) => unwrap<any[]>(api.get('/casting/receipts', { params })),
    produced: (itemId?: number) => unwrap<{ rows: any[]; byDesign: any[]; shortByProcess: Record<string, number> }>(api.get('/casting/produced', { params: { itemId } })),
    // Repair-order endpoints (Reject/Repair module).
    listRepairs: (params?: { status?: string; vendorId?: number; batchId?: number; search?: string }) =>
      unwrap<any[]>(api.get('/casting/repairs', { params })),
    getRepair: (id: number) => unwrap<any>(api.get(`/casting/repairs/${id}`)),
    finalRejectRepair: (
      id: number,
      body: { qty: number; reason?: string; paymentMode: 'NO_PAY' | 'ADJUSTED' | 'FULL_PAY'; adjustment?: number },
    ) => unwrap<{ id: number; status: string; qty: number }>(api.post(`/casting/repairs/${id}/final-reject`, body)),
    repairPdfUrl: (id: number) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/casting/repairs/${id}/pdf`,
    stageLineage: (stageId: number) => unwrap<{ chain: any[] }>(api.get(`/casting/stages/${stageId}/lineage`)),
    settle: (body: { stageIds: number[]; nextProcessId: number; color?: string; vendorId?: number; maxQty?: number; targetBatchId?: number }) =>
      unwrap<{ forwarded: number }>(api.post('/casting/settle', body)),
    planForward: (stageId: number, body: { nextProcessId: number | null; vendorId?: number | null; color?: string | null; targetBatchId?: number | null }) =>
      unwrap<{ id: number }>(api.post(`/casting/stages/${stageId}/plan-forward`, body)),
    createReceipt: (body: any) => unwrap<any>(api.post('/casting/receipts', body)),
    // Single receipt detail — used to pre-fill the Edit Receipt form
    // (returns header + per-row QC buckets in the same shape createReceipt
    // accepts as input).
    receipt: (receiptId: number) => unwrap<any>(api.get(`/casting/receipts/${receiptId}`)),
    // Edit in place — same receipt id + receiptNumber preserved. Backend
    // guards forwarded-out + repair-related rows; refusals come back as
    // BadRequest with a clear message the form surfaces as a toast.
    updateReceipt: (receiptId: number, body: any) =>
      unwrap<any>(api.put(`/casting/receipts/${receiptId}`, body)),
    deleteReceipt: (receiptId: number) => unwrap<any>(api.delete(`/casting/receipts/${receiptId}`)),
    closeItem: (batchItemId: number, reason?: string) =>
      unwrap<any>(api.post(`/casting/batch-items/${batchItemId}/close`, { reason })),
    closeBatch: (batchId: number, reason?: string) =>
      unwrap<{ closedStages: number }>(api.post(`/casting/batches/${batchId}/close`, { reason })),
    reopenBatch: (batchId: number) =>
      unwrap<{ id: number }>(api.post(`/casting/batches/${batchId}/reopen`, {})),
    reopenItem: (batchItemId: number) =>
      unwrap<any>(api.post(`/casting/batch-items/${batchItemId}/reopen`, {})),
    forwardStage: (batchItemId: number, body: { processId: number; quantity: number; vendorId?: number; vendorDesignReference?: string; weight?: number; totalWeight?: number; costPerKg?: number; color?: string; remarks?: string; bringsOwnMaterials?: boolean; materialBufferPercent?: number; materialIssueOverride?: { variantId: number; issuedQty: number }[]; bomCapture?: { variantId: number; perPiece: number }[]; extraMaterials?: { variantId: number; issuedQty?: number; issuedWeight?: number; notes?: string }[]; forwardDate?: string; purpose?: string }) =>
      unwrap<any>(api.post(`/casting/batch-items/${batchItemId}/forward`, body)),
    // Confirm the final per-piece Casting weight after the operator weighs
    // returned pieces. Called from the receipt form's popup when the receipt
    // response carries needsFinalWeight[]. Saves to Item Master and clears
    // the "casting weight temporary" marker from notes.
    finalizeCastingWeight: (body: { itemId: number; weight: number }) =>
      unwrap<{ itemId: number; weight: number; markerCleared: boolean }>(
        api.post('/casting/finalize-casting-weight', body),
      ),
    // Post-Packing details per production variant — additional charge,
    // gross/less/net wt. Called from the modal that pops after packing
    // receipt success (or from the deferred /items pending list).
    savePackingDetails: (
      variantId: number,
      body: { additionalCharge?: number | null; grossWt?: number | null; lessWt?: number | null; netWt?: number | null },
    ) => unwrap<any>(api.post(`/casting/production-variants/${variantId}/packing-details`, body)),
    pendingPackingDetails: () =>
      unwrap<any[]>(api.get('/casting/pending-packing-details')),
    // Vendor's MOST RECENT rate for a process — pre-fills the rate field in
    // batch / forward / edit forms when the chosen (item × vendor) master
    // has no rate. Null when no history exists for the (vendor × process).
    vendorRate: (vendorId: number, processId: number) =>
      unwrap<{ rate: number | null }>(
        api.get('/casting/vendor-rate', { params: { vendorId, processId } }),
      ),
    // Bulk-download URL — all slips of a (batch × process) packed as ZIP.
    // kind: 'issue' = vendor PDFs only; 'receipt' = receipt PDFs only;
    // 'all' = both. Public route, opens directly in the browser.
    processSlipsZipUrl: (batchId: number, processId: number, kind: 'issue' | 'receipt' | 'all', tax?: 'GST' | 'URD' | null) => {
      const qs = new URLSearchParams();
      qs.set('processId', String(processId));
      qs.set('kind', kind);
      if (tax) qs.set('tax', tax);
      return `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/casting/batches/${batchId}/process-slips.zip?${qs.toString()}`;
    },
    previewStickingIssue: (body: { itemId: number; splits: { color?: string | null; quantity: number }[]; bufferPercent?: number }) =>
      unwrap<{ lines: {
        variantId: number; variantCode: string; variantName: string; unit: string | null;
        required: number; defaultIssue: number; stockQty: number;
        // Calculation transparency — show "N × P = R" or per-colour breakdown
        // in the BOM table, matching the user's expected voucher layout.
        perPiece: number | null;
        totalPcs: number;
        breakdown: { color: string | null; qty: number; perPiece: number; subtotal: number }[];
      }[] }>(
        api.post('/casting/preview-sticking-issue', body),
      ),
    updateStage: (batchItemId: number, body: { vendorId?: number; vendorDesignReference?: string; quantity?: number; weight?: number; totalWeight?: number; costPerKg?: number; color?: string; remarks?: string; purpose?: string; itemId?: number; issueDate?: string }) =>
      unwrap<any>(api.put(`/casting/batch-items/${batchItemId}`, body)),
    // Add a single design row to an existing OPEN batch (per-row "+ Add
    // design" on the batch detail page). Creates a root Casting stage;
    // auto-syncs vendor / rate / weight to Item Master like createBatch.
    addBatchDesign: (batchId: number, body: any) =>
      unwrap<{ id: number; batchId: number; rateUpdates: any[]; tempWeightFlagged: number[] }>(
        api.post(`/casting/batches/${batchId}/add-design`, body),
      ),
    // Undo a mistaken forward — deletes an unreceived child stage and
    // rolls back any auto-issued materials. Backend guards (no receipts,
    // no children, not short-closed, must be a child stage).
    deleteStage: (stageId: number) =>
      unwrap<{ id: number; batchId: number }>(api.delete(`/casting/stages/${stageId}`)),
    reportMissingParts: (stageId: number, body: { parts: { partName: string; qtyMissing: number; notes?: string }[] }) =>
      unwrap<{ created: { id: number; partName: string; qtyMissing: number }[] }>(
        api.post(`/casting/stages/${stageId}/report-missing-parts`, body),
      ),
    vendorLedger: (vendorId: number, from?: string, to?: string) =>
      unwrap<any>(api.get(`/casting/vendor-ledger/${vendorId}`, { params: { from, to } })),
    // Per-vendor drift accumulator — claimed sent vs actual received across
    // every receipt-item that recorded a claim. Omit vendorId for the
    // fleet-wide roll-up; pass it for the drilled-in per-row detail.
    vendorDrift: (opts?: { vendorId?: number; from?: string; to?: string }) =>
      unwrap<{
        from: string; to: string;
        vendors: {
          vendorId: number; vendorCode: string | null; vendorName: string | null;
          totalClaimed: number; totalReceived: number; totalDrift: number;
          receiptCount: number; rowCount: number;
        }[];
        detail?: {
          receiptId: number; receiptNumber: string; receiptDate: string;
          batchNumber: string | null; itemNumber: string | null;
          designCode: string | null;
          processCode: string | null; processName: string | null;
          claimedSentWeight: number; receivedWeight: number; drift: number;
        }[];
      }>(api.get(`/casting/vendor-drift`, {
        params: {
          vendorId: opts?.vendorId,
          from: opts?.from, to: opts?.to,
        },
      })),
    pdfUrl: (
      batchId: number,
      vendorId: number,
      processId?: number,
      tax?: 'GST' | 'URD' | null,
      forwardDate?: string | null,
    ) => {
      const qs = new URLSearchParams();
      if (processId) qs.set('processId', String(processId));
      if (tax) qs.set('tax', tax);
      // YYYY-MM-DD — scopes the slip to one day's forwards for this vendor.
      // Omit to aggregate every day (legacy behaviour).
      if (forwardDate) qs.set('forwardDate', forwardDate);
      const q = qs.toString();
      return `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/casting/batches/${batchId}/pdf/${vendorId}${q ? `?${q}` : ''}`;
    },
    stagePdfUrl: (stageId: number, tax?: 'GST' | 'URD' | null) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/casting/stages/${stageId}/pdf${tax ? `?tax=${tax}` : ''}`,
    receiptPdfUrl: (receiptId: number, tax?: 'GST' | 'URD' | null) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/casting/receipts/${receiptId}/pdf${tax ? `?tax=${tax}` : ''}`,
    // Downloadable PDF report for the Vendor Ledger page — sectioned (Work
    // Done / Under Process / Rejected / Short-Closed / Repair) with subtotals
    // and grand-total payable.
    vendorLedgerReportPdfUrl: (vendorId: number, from?: string, to?: string) => {
      const qs = new URLSearchParams();
      if (from) qs.set('from', from);
      if (to) qs.set('to', to);
      const q = qs.toString();
      return `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/casting/vendor-ledger/${vendorId}/report.pdf${q ? `?${q}` : ''}`;
    },
  },

  materialIssues: {
    list: (params?: { vendorId?: number; status?: string }) =>
      unwrap<any[]>(api.get('/material-issues', { params })),
    get: (id: number) => unwrap<any>(api.get(`/material-issues/${id}`)),
    nextVoucherNumber: () => unwrap<{ voucherNumber: string }>(api.get('/material-issues/next-voucher-number')),
    vendorHoldings: (vendorId?: number) =>
      unwrap<any[]>(api.get('/material-issues/vendor-holdings', { params: { vendorId } })),
    pendingDemand: (variantId?: number) =>
      unwrap<{
        lineId: number; variantId: number; variantCode: string; variantName: string; unit: string | null;
        deferredQty: number; availableStock: number;
        voucherNumber: string; voucherId: number; vendorId: number; vendorCode: string; vendorName: string;
        batchNumber: string | null; itemNumber: string | null;
      }[]>(api.get('/material-issues/pending-demand', { params: { variantId } })),
    issueDeferred: (lineId: number, qty: number) =>
      unwrap<{ id: number; issued: number; deferredRemaining: number }>(
        api.post(`/material-issues/lines/${lineId}/issue-deferred`, { qty }),
      ),
    create: (body: {
      vendorId: number; batchId?: number; stageId?: number; issueDate?: string; notes?: string;
      lines: { variantId: number; issuedQty: number; notes?: string }[];
    }) => unwrap<{ id: number; voucherNumber: string }>(api.post('/material-issues', body)),
    recordReturn: (id: number, body: { lines: { lineId: number; returnedQty: number; consumedQty?: number; notes?: string }[]; notes?: string }) =>
      unwrap<any>(api.post(`/material-issues/${id}/return`, body)),
    vendorReturn: (body: { vendorId: number; items: { variantId: number; returnedQty: number }[] }) =>
      unwrap<{ items: { variantId: number; returned: number; allocations: { voucherNumber: string; qty: number }[] }[] }>(
        api.post('/material-issues/vendor-return', body),
      ),
    close: (id: number, body?: { reason?: string }) =>
      unwrap<any>(api.post(`/material-issues/${id}/close`, body ?? {})),
    remove: (id: number) => unwrap<any>(api.delete(`/material-issues/${id}`)),
    issuePdfUrl: (id: number) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/material-issues/${id}/pdf`,
    returnPdfUrl: (id: number) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/material-issues/${id}/return-pdf`,
  },

  upload: async (file: File, module: string, type: 'image' | 'cad' = 'image') => {
    const fd = new FormData();
    fd.append('file', file);
    return unwrap<{ path: string; url: string }>(
      api.post(`/uploads?module=${module}&type=${type}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }),
    );
  },

  // ---- Missing-parts / Recast ----
  // Mounted under the casting controller's `/casting` prefix on the
  // backend — paths must include it or the dashboard widget 404s.
  missingParts: {
    pending: () => unwrap<any[]>(api.get('/casting/missing-parts/pending')),
    recast: (id: number, where: 'SAME_BATCH' | 'NEW_BATCH') =>
      unwrap<any>(api.post(`/casting/missing-parts/${id}/recast`, { where })),
  },

  // ---- Billing ----
  billing: {
    customers: (search?: string) =>
      unwrap<any[]>(api.get('/customers', { params: { search } })),
    getCustomer: (id: number) => unwrap<any>(api.get(`/customers/${id}`)),
    createCustomer: (body: any) => unwrap<any>(api.post('/customers', body)),
    updateCustomer: (id: number, body: any) =>
      unwrap<any>(api.put(`/customers/${id}`, body)),
    customerLedger: (id: number) =>
      unwrap<any>(api.get(`/customers/${id}/ledger`)),

    invoices: (params?: Record<string, any>) =>
      unwrap<any[]>(api.get('/invoices', { params })),
    invoice: (id: number) => unwrap<any>(api.get(`/invoices/${id}`)),
    invoiceablePieces: () => unwrap<any[]>(api.get('/invoices/invoiceable')),
    createInvoice: (body: any) => unwrap<any>(api.post('/invoices', body)),
    updateInvoice: (id: number, body: any) => unwrap<any>(api.put(`/invoices/${id}`, body)),
    cancelInvoice: (id: number) =>
      unwrap<any>(api.post(`/invoices/${id}/cancel`, {})),
    deleteInvoice: (id: number) =>
      unwrap<any>(api.delete(`/invoices/${id}`)),
    convertEstimate: (id: number) =>
      unwrap<any>(api.post(`/invoices/${id}/convert`, {})),
    // Consolidate an Estimate into a single-row TEMP_INVOICE. PDF prints
    // as a regular invoice; the TEMP marker lives on the record type.
    generateTempInvoice: (estimateId: number) =>
      unwrap<any>(api.post(`/invoices/${estimateId}/temp-invoice`, {})),
    // Raise a single ABN-XXXXXX tax invoice for silver received against
    // multiple estimates. Backend allocates per-estimate grams, one
    // consolidated silver line on the invoice.
    raiseMetalInvoice: (body: {
      customerId: number;
      invoiceDate: string;
      silverRatePerG: number;
      coverages: { estimateId: number; silverAllocatedG: number }[];
      notes?: string;
      dueDate?: string;
      gstPercent?: number;
      isInterState?: boolean;
    }) => unwrap<any>(api.post('/metal-invoice', body)),
    invoicePdfUrl: (id: number) =>
      `${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000/api'}/invoices/${id}/pdf`,

    payments: (params?: Record<string, any>) =>
      unwrap<any[]>(api.get('/payments', { params })),
    createPayment: (body: any) => unwrap<any>(api.post('/payments', body)),
    convertInvoiceTo: (id: number, toType: 'SALES_ORDER' | 'TAX_INVOICE') =>
      unwrap<any>(api.post(`/invoices/${id}/convert`, { toType })),

    chargeTypes: () => unwrap<any[]>(api.get('/charge-types')),
    createChargeType: (name: string) =>
      unwrap<any>(api.post('/charge-types', { name })),
  },

  purchases: {
    bills: (params?: Record<string, any>) =>
      unwrap<any[]>(api.get('/bills', { params })),
    bill: (id: number) => unwrap<any>(api.get(`/bills/${id}`)),
    createBill: (body: any) => unwrap<any>(api.post('/bills', body)),
    cancelBill: (id: number) =>
      unwrap<any>(api.post(`/bills/${id}/cancel`, {})),
    convertPo: (id: number) =>
      unwrap<any>(api.post(`/bills/${id}/convert-po`, {})),
    payments: (params?: Record<string, any>) =>
      unwrap<any[]>(api.get('/vendor-payments', { params })),
    createPayment: (body: any) => unwrap<any>(api.post('/vendor-payments', body)),
  },

  recurring: {
    list: () => unwrap<any[]>(api.get('/recurring-invoices')),
    create: (body: any) => unwrap<any>(api.post('/recurring-invoices', body)),
    toggle: (id: number, enabled: boolean) =>
      unwrap<any>(api.put(`/recurring-invoices/${id}/toggle`, { enabled })),
    runDue: () => unwrap<any>(api.post('/recurring-invoices/run-due', {})),
  },
};
