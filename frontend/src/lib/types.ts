export type ActiveStatus = 'ACTIVE' | 'INACTIVE';
export type DesignType = 'CAD' | 'HANDMADE';
export type SampleStatus =
  | 'DRAFT'
  | 'IN_DEVELOPMENT'
  | 'SAMPLE_READY'
  | 'PRODUCTION_READY';

export interface AuthUser {
  id: number;
  username: string;
  fullName: string;
  role: string;
}

export interface ProcessMeta {
  id: number;
  code: string;
  name: string;
  attributes: { key: string; label: string }[];
}

export interface VendorLite {
  id: number;
  vendorCode: string;
  vendorName: string;
  shortName?: string | null;
}

export interface ProcessServiceMeta {
  id: number;
  code: string;
  name: string;
  appliesTo?: string | null;
}

export interface Vendor {
  id: number;
  vendorCode: string;
  vendorName: string;
  shortName?: string | null;
  contactPerson?: string | null;
  mobile?: string | null;
  email?: string | null;
  address?: string | null;
  gstNumber?: string | null;
  panNumber?: string | null;
  notes?: string | null;
  status: ActiveStatus;
  processIds: number[];
  processNames?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface VariantVendor {
  id?: number;
  vendorId: number;
  vendorCode?: string;
  vendorName?: string;
  vendorReference?: string | null;
  price?: number | null;
  moq?: number | null;
  isPreferred?: boolean;
  notes?: string | null;
}

export interface MaterialVariant {
  id: number;
  variantCode: string;
  variantName: string;
  materialName: string;
  materialCode: string;
  code?: string; // generated: supplierShort-material-size-colour
  categoryId?: number | null;
  categoryName?: string | null;
  size?: string | null;
  color?: string | null;
  finish?: string | null;
  shape?: string | null;
  unit?: string | null;
  imagePath?: string | null;
  imageUrl?: string | null;
  notes?: string | null;
  status: ActiveStatus;
  vendorCount?: number;
  minPrice?: number | null;
  stockQty?: number;
  vendors?: VariantVendor[];
}

export interface ProcessPhoto {
  id?: number;
  filePath?: string;
  url?: string;
}

export interface ItemProcessVendor {
  id?: number;
  vendorId: number;
  vendorCode?: string;
  vendorName?: string;
  vendorDesignReference?: string | null;
  color?: string | null;
  costPerPiece?: number | null;
  isPreferred?: boolean;
  notes?: string | null;
  photos?: ProcessPhoto[];
}

export interface ItemProcessServiceRow {
  serviceId: number;
  name?: string;
  cost?: number | null;
}

export interface ItemProcess {
  itemProcessId?: number;
  processId: number;
  code?: string;
  name?: string;
  costUnit?: 'KG' | 'PIECE';
  notes?: string | null;
  attributes: Record<string, string>;
  photos?: ProcessPhoto[];
  services?: ItemProcessServiceRow[];
  vendors: ItemProcessVendor[];
}

export interface ItemImage {
  id: number;
  filePath: string;
  url: string;
  isPrimary: boolean;
}

export interface ItemListRow {
  id: number;
  sampleDesignCode: string;
  itemNumber?: string | null;
  category?: string | null;
  collection?: string | null;
  designType?: DesignType | null;
  designerName?: string | null;
  sellingPrice?: number | null;
  costPrice?: number | null;
  sampleStatus: SampleStatus;
  updatedAt: string;
  thumbUrl?: string | null;
  // Sum of OPEN repair-order qty across every batch for this item.
  // Drives the "🔧 N at repair" badge on the items list.
  openRepairQty?: number;
  // Short labels of master fields the operator still needs to fill in
  // (e.g. ["image", "casting wt", "BOM"]). Empty when the design is
  // fully populated. Drives the Pending column chip strip on the
  // Items list so operators can triage what's missing at a glance.
  pending?: string[];
}

export interface BomLine {
  variantId: number;
  variantCode?: string;
  variantName?: string;
  materialName?: string;
  size?: string | null;
  color?: string | null;
  stickingColor?: string | null;
  unit?: string | null;
  quantity: number;
  wastagePercent: number;
  price?: number;
  stockQty?: number;
  lineCost?: number;
  notes?: string | null;
}

export interface VariantLite {
  id: number;
  variantCode: string;
  variantName: string;
  // materialId + shape + finish surfaced so the Sticking-BOM "Copy from
  // colour" feature can structurally match variants across colours via
  // (materialId × size × shape × finish).
  materialId: number;
  materialName: string;
  size?: string | null;
  color?: string | null;
  shape?: string | null;
  finish?: string | null;
  unit?: string | null;
  stockQty: number;
  price: number;
}

export interface ColorModelProcess {
  processId: number;
  color: string;
}

export interface ItemColorModel {
  id?: number;
  letter: string;
  name: string;
  photoPath?: string | null;
  photoUrl?: string | null;
  costPrice?: number | null;
  sellingPrice?: number | null;
  processColors: ColorModelProcess[];
}

export interface CostBreakup {
  lines: { label: string; amount: number }[];
  total: number;
}

export interface Item {
  id: number;
  sampleDesignCode: string;
  itemNumber?: string | null;
  category?: string | null;
  subcategory?: string | null;
  collection?: string | null;
  notes?: string | null;
  designType?: DesignType | null;
  designerName?: string | null;
  designerShortName?: string | null;
  designCost?: number | null;
  sellingPrice?: number | null;
  costPrice?: number | null;
  cadFilePath?: string | null;
  cadFileUrl?: string | null;
  sampleStatus: SampleStatus;
  images: ItemImage[];
  processes: ItemProcess[];
  materials?: BomLine[];
  colorModels?: ItemColorModel[];
  costBreakup?: CostBreakup;
}

export interface ItemMeta {
  processes: (ProcessMeta & {
    vendors: VendorLite[];
    usesColor: boolean;
    colorModelStep: boolean;
    usesServices: boolean;
    batchOnly: boolean;
    costUnit: 'KG' | 'PIECE';
  })[];
  allVendors: VendorLite[];
  designers: VendorLite[];
  services: ProcessServiceMeta[];
  variants: VariantLite[];
  sampleStatuses: SampleStatus[];
}

export interface Category {
  id: number;
  name: string;
}
