export interface NativeTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  amount: number;
}

export interface TokenTransfer {
  fromUserAccount: string | null;
  toUserAccount: string | null;
  fromTokenAccount?: string | null;
  toTokenAccount?: string | null;
  mint: string;
  tokenAmount: number;
  tokenStandard?: string;
}

export interface AccountData {
  account: string;
  nativeBalanceChange: number;
  tokenBalanceChanges: Array<{
    userAccount: string;
    tokenAccount: string;
    mint: string;
    rawTokenAmount: { tokenAmount: string; decimals: number };
  }>;
}

export interface EnhancedTransaction {
  signature: string;
  slot: number;
  timestamp: number;
  type: string;
  source: string;
  fee: number;
  feePayer: string;
  description: string;
  nativeTransfers?: NativeTransfer[];
  tokenTransfers?: TokenTransfer[];
  accountData?: AccountData[];
  transactionError?: unknown;
  events?: {
    swap?: SwapEvent;
    nft?: unknown;
    compressed?: unknown;
    setAuthority?: unknown;
  };
  instructions?: Array<{
    programId: string;
    data: string;
    accounts: string[];
    innerInstructions?: Array<{ programId: string; data: string; accounts: string[] }>;
  }>;
}

export interface SwapTokenLeg {
  mint: string;
  tokenAmount: string | number;
  rawTokenAmount?: { tokenAmount: string; decimals: number };
  userAccount?: string;
  tokenAccount?: string;
}

export interface SwapEvent {
  nativeInput?: { account: string; amount: string };
  nativeOutput?: { account: string; amount: string };
  tokenInputs?: SwapTokenLeg[];
  tokenOutputs?: SwapTokenLeg[];
  tokenFees?: SwapTokenLeg[];
  nativeFees?: Array<{ account: string; amount: string }>;
  innerSwaps?: unknown[];
}

export interface DasAsset {
  id: string;
  interface: string;
  burnt?: boolean;
  mutable?: boolean;
  content?: {
    metadata?: { name?: string; symbol?: string; description?: string };
    links?: { image?: string; external_url?: string };
    json_uri?: string;
  };
  ownership?: {
    owner: string;
    frozen: boolean;
    delegated: boolean;
    delegate?: string | null;
    ownership_model: string;
  };
  authorities?: Array<{ address: string; scopes: string[] }>;
  creators?: Array<{ address: string; share: number; verified: boolean }>;
  grouping?: Array<{ group_key: string; group_value: string }>;
  royalty?: { percent: number; basis_points: number; primary_sale_happened: boolean };
  compression?: { compressed: boolean; tree?: string; seq?: number; leaf_id?: number };
  supply?: { print_max_supply?: number; print_current_supply?: number } | null;
  token_info?: {
    symbol?: string;
    supply?: number;
    decimals?: number;
    token_program?: string;
    mint_authority?: string | null;
    freeze_authority?: string | null;
    associated_token_address?: string;
    balance?: number;
    price_info?: { price_per_token: number; total_price?: number; currency: string };
  };
}

export interface DasPage<T> {
  total: number;
  limit: number;
  page?: number;
  cursor?: string;
  items: T[];
  nativeBalance?: {
    lamports: number;
    price_per_sol?: number;
    total_price?: number;
  };
}

export interface TransferRecord {
  signature: string;
  slot: number;
  blockTime: number;
  type: string;
  fromUserAccount: string | null;
  toUserAccount: string | null;
  fromTokenAccount?: string | null;
  toTokenAccount?: string | null;
  mint: string;
  amount: string;
  decimals: number;
  uiAmount: string | number;
  confirmationStatus?: string;
  transactionIdx?: number;
  instructionIdx?: number;
  innerInstructionIdx?: number;
}

export interface SignatureInfo {
  signature: string;
  slot: number;
  blockTime: number | null;
  err: unknown;
  memo: string | null;
  confirmationStatus?: string;
}
