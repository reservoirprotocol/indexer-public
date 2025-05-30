/* eslint-disable @typescript-eslint/no-explicit-any */

import { formatEth, fromBuffer } from "@/common/utils";
import * as Sdk from "@reservoir0x/sdk";
import { config } from "@/config/index";

import { BuildDocumentData, BaseDocument, DocumentBuilder } from "@/elasticsearch/indexes/base";

export enum ActivityType {
  nftSale = "sale",
  nftAsk = "ask",
  nftTransfer = "transfer",
  nftMint = "mint",
  nftBid = "bid",
  nftBidCancel = "bid_cancel",
  nftAskCancel = "ask_cancel",
  tokenTransfer = "token_transfer",
  contractCall = "contract_call",
  bridge = "bridge",
  swap = "swap",
}

export interface SwapCurrency {
  chainId: string;
  txHash: string;
  currency: {
    contract: string;
    name?: string;
    symbol?: string;
    decimals?: number;
    metadata: {
      image?: string | null;
    };
  };
  amount: {
    raw: string;
    decimal: string;
    usd: string;
  };
}

export interface ActivityDocument extends BaseDocument {
  timestamp: number;
  type: ActivityType;
  contract: string;
  fromAddress: string;
  toAddress: string | null;
  fromCurrency?: string;
  toCurrency?: string;
  amount?: string;
  pricing?: {
    price?: string;
    priceDecimal?: number;
    currencyPrice?: string;
    usdPrice?: number;
    feeBps?: number;
    currency?: string;
    value?: string;
    valueDecimal?: number;
    currencyValue?: string;
    normalizedValue?: string;
    normalizedValueDecimal?: number;
    currencyNormalizedValue?: string;
  };
  event?: {
    timestamp: number;
    txHash: string;
    logIndex: number;
    batchIndex: number;
    blockHash: string;
    gasPrice?: string;
    value?: string;
    functionSelector?: string;
    fillSourceId?: number;
    washTradingScore: number;
    collectionIsMinting: boolean;
    collectionMintType: string;
    collectionMintStandard?: string;
    transferIsAirdrop?: boolean;
    comment?: string;
  };
  data?: any;
  fillEvent?: {
    fillSourceId: number;
    comment: string;
    washTradingScore: number;
  };
  nftTransferEvent?: {
    isAirdrop: boolean;
  };
  ftTransferEvent?: {
    amountUsd: string;
  };
  transaction?: {
    gasPrice: string;
    value: string;
    functionSelector: string;
  };
  collectionMint?: {
    isMinting: boolean;
    mintType?: string;
    mintStandard?: string;
  };
  token?: {
    id: string;
    name: string;
    image: string;
    media: string;
    isSpam: boolean;
    isNsfw: boolean;
  };
  collection?: {
    id: string;
    name: string;
    image: string;
    isSpam: boolean;
    isNsfw: boolean;
    imageVersion: number;
  };
  order?: {
    id: string;
    side: string;
    sourceId: number;
    kind: string;
    criteria: {
      kind: string;
      data: {
        attribute?: {
          key: string;
          value: string;
        };
        collection?: {
          id: string;
        };
        token?: {
          tokenId: string;
        };
      };
    };
  };
  swap?: {
    fromCurrency: SwapCurrency;
    toCurrency: SwapCurrency;
  };
}

export interface CollectionAggregation {
  id: string;
  name: string;
  image: string;
  primaryAssetContract: string;
  count: number;
  volume: number;
}

export interface BuildActivityData extends BuildDocumentData {
  id: string;
  type: ActivityType;
  timestamp: number;
  contract: Buffer;
  collection_id: string;
  token_id?: string;
  from: Buffer;
  to?: Buffer;
  pricing_price?: number;
  pricing_currency_price?: Buffer;
  pricing_usd_price: number;
  pricing_fee_bps?: number;
  pricing_currency?: Buffer;
  pricing_value?: number;
  pricing_currency_value?: number;
  pricing_normalized_value?: number;
  pricing_currency_normalized_value?: number;
  amount?: string;
  token_name?: string;
  token_image?: string;
  token_media?: string;
  collection_name?: string;
  collection_image?: string;
  collection_mint_standard?: string;
  event_block_hash?: Buffer | null;
  event_gas_price?: string | null;
  event_value?: string | null;
  event_function_selector?: string | null;
  event_timestamp?: number;
  event_tx_hash?: Buffer;
  event_log_index?: number;
  event_batch_index?: number;
  event_fill_source_id?: number;
  event_comment?: string;
  event_wash_trading_score?: number;
  event_collection_is_minting?: boolean;
  event_collection_mint_price?: number;
  event_transfer_kind?: string;
  order_id?: string | null;
  order_side?: string;
  order_source_id_int?: number;
  order_kind?: string;
  collection_is_spam?: number | null;
  collection_nsfw_status?: number | null;
  collection_image_version?: number | null;
  token_is_spam?: number | null;
  token_nsfw_status?: number | null;
  order_criteria?: {
    kind: string;
    data: Record<string, unknown>;
  };
  created_ts: number;
  from_currency?: string;
  to_currency?: string;
}

export class ActivityBuilder extends DocumentBuilder {
  public buildDocument(data: BuildActivityData): ActivityDocument {
    const baseActivity = super.buildDocument(data);

    return {
      ...baseActivity,
      timestamp: data.timestamp,
      createdAt: data.created_ts ? new Date(data.created_ts * 1000) : baseActivity.createdAt,
      type: data.type,
      fromAddress: fromBuffer(data.from),
      toAddress: data.to ? fromBuffer(data.to) : undefined,
      fromCurrency: data.from_currency,
      toCurrency: data.to_currency,
      amount: data.amount ?? "0",
      contract: data.contract ? fromBuffer(data.contract) : undefined,
      pricing: data.pricing_price
        ? {
            price: String(data.pricing_price),
            priceDecimal: formatEth(data.pricing_price),
            currencyPrice: data.pricing_currency_price
              ? String(data.pricing_currency_price)
              : undefined,
            usdPrice: data.pricing_usd_price ?? undefined,
            feeBps: data.pricing_fee_bps ?? undefined,
            currency: data.pricing_currency
              ? fromBuffer(data.pricing_currency)
              : Sdk.Common.Addresses.Native[config.chainId],
            value: data.pricing_value ? String(data.pricing_value) : undefined,
            valueDecimal: data.pricing_value ? formatEth(data.pricing_value) : undefined,
            currencyValue: data.pricing_currency_value
              ? String(data.pricing_currency_value)
              : undefined,
            normalizedValue: data.pricing_normalized_value
              ? String(data.pricing_normalized_value)
              : undefined,
            normalizedValueDecimal: data.pricing_normalized_value
              ? formatEth(data.pricing_normalized_value)
              : undefined,
            currencyNormalizedValue: data.pricing_currency_normalized_value
              ? String(data.pricing_currency_normalized_value)
              : undefined,
          }
        : undefined,
      event: data.event_tx_hash
        ? {
            timestamp: data.event_timestamp,
            txHash: fromBuffer(data.event_tx_hash),
            logIndex: data.event_log_index,
            batchIndex: data.event_batch_index,
            blockHash: data.event_block_hash ? fromBuffer(data.event_block_hash) : undefined,
            gasPrice: data.event_gas_price ? String(data.event_gas_price) : undefined,
            value: data.event_value ? String(data.event_value) : undefined,
            functionSelector: data.event_function_selector
              ? String(data.event_function_selector)
              : undefined,
            fillSourceId: data.event_fill_source_id,
            comment: data.event_comment,
            washTradingScore: data.event_wash_trading_score,
            collectionIsMinting: data.event_collection_is_minting,
            collectionMintType:
              data.event_collection_mint_price != null
                ? data.event_collection_mint_price > 0
                  ? "paid"
                  : "free"
                : undefined,
            transferIsAirdrop: data.event_transfer_kind
              ? data.event_transfer_kind === "airdrop"
              : undefined,
          }
        : undefined,
      token: data.token_id
        ? {
            id: data.token_id,
            name: data.token_name,
            image: data.token_image?.startsWith("data:") ? undefined : data.token_image,
            isSpam: Number(data.token_is_spam) > 0,
            isNsfw: Number(data.token_nsfw_status) > 0,
          }
        : undefined,
      collection: data.collection_id
        ? {
            id: data.collection_id,
            name: data.collection_name,
            image: data.collection_image?.startsWith("data:") ? undefined : data.collection_image,
            isSpam: Number(data.collection_is_spam) > 0,
            isNsfw: Number(data.collection_nsfw_status) > 0,
            imageVersion: data.collection_image_version
              ? Math.floor(new Date(data.collection_image_version).getTime() / 1000)
              : undefined,
            mintStandard: data.collection_mint_standard,
          }
        : undefined,
      collectionMint:
        data.event_collection_is_minting != null
          ? {
              isMinting: data.event_collection_is_minting,
              mintType:
                data.event_collection_mint_price != null
                  ? data.event_collection_mint_price > 0
                    ? "paid"
                    : "free"
                  : undefined,
              mintStandard: data.collection_mint_standard,
            }
          : undefined,
      order: data.order_id
        ? {
            id: data.order_id,
            side: data.order_side,
            sourceId: data.order_source_id_int,
            criteria: data.order_criteria,
          }
        : undefined,
    } as ActivityDocument;
  }
}
