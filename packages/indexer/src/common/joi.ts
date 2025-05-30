/* eslint-disable @typescript-eslint/no-explicit-any */

import { BigNumberish } from "@ethersproject/bignumber";
import { parseEther } from "@ethersproject/units";
import * as Sdk from "@reservoir0x/sdk";
import crypto from "crypto";
import Joi from "joi";
import _ from "lodash";

import { bn, formatEth, formatPrice, formatUsd, fromBuffer, now, regex } from "@/common/utils";
import { config } from "@/config/index";
import { FeeRecipients } from "@/models/fee-recipients";
import { Sources } from "@/models/sources";
import { SourcesEntity } from "@/models/sources/sources-entity";
import { OrderKind } from "@/orderbook/orders";
import { Currency, getCurrency } from "@/utils/currencies";
import {
  getUSDAndCurrencyPrices,
  getUSDAndNativePrices,
  isWhitelistedCurrency,
} from "@/utils/prices";
import { Assets, ImageSize } from "@/utils/assets";
import { isOrderNativeOffChainCancellable } from "@/utils/offchain-cancel";
import { ActivityDocument, ActivityType } from "@/elasticsearch/indexes/activities/base";

// --- Prices ---

const JoiPriceAmount = Joi.object({
  raw: Joi.string().pattern(regex.number),
  decimal: Joi.number().unsafe(),
  usd: Joi.number().unsafe().allow(null),
  native: Joi.number().unsafe().allow(null),
});

const JoiPriceCurrency = Joi.object({
  contract: Joi.string().pattern(regex.address),
  name: Joi.string().allow(null),
  symbol: Joi.string().allow(null),
  decimals: Joi.number().allow(null),
  chainId: Joi.number().optional(),
});

export const JoiPrice = Joi.object({
  currency: JoiPriceCurrency,
  amount: JoiPriceAmount.description("Amount with fees & royalties included."),
  netAmount: JoiPriceAmount.optional().description("Amount with fees & royalties removed."),
});

export const JoiDynamicPrice = Joi.alternatives(
  Joi.object({
    kind: "dutch",
    data: Joi.object({
      price: Joi.object({
        start: JoiPrice,
        end: JoiPrice,
      }),
      time: Joi.object({
        start: Joi.number(),
        end: Joi.number(),
      }),
    }),
  }),
  Joi.object({
    kind: "pool",
    data: Joi.object({
      pool: Joi.string(),
      prices: Joi.array().items(JoiPrice),
    }),
  })
);

export const JoiActivityTypeMapping: { [key: string]: string } = {
  [ActivityType.nftTransfer]: "nft_transfer",
  [ActivityType.nftMint]: "nft_mint",
  [ActivityType.nftSale]: "nft_sale",
  [ActivityType.nftAsk]: "nft_ask",
  [ActivityType.nftAskCancel]: "nft_ask_cancel",
  [ActivityType.nftBid]: "nft_bid",
  [ActivityType.nftBidCancel]: "nft_bid_cancel",
  [ActivityType.tokenTransfer]: ActivityType.tokenTransfer,
  [ActivityType.contractCall]: ActivityType.contractCall,
  [ActivityType.bridge]: ActivityType.bridge,
  [ActivityType.swap]: ActivityType.swap,
};

const subFeeWithBps = (amount: BigNumberish, totalFeeBps: number) => {
  return bn(amount).sub(bn(amount).mul(totalFeeBps).div(10000)).toString();
};

export const getJoiAmountObject = async (
  currency: Currency,
  amount: string,
  nativeAmount?: string,
  usdAmount?: string,
  totalFeeBps?: number
) => {
  let usdPrice = usdAmount;
  if (amount && !usdPrice) {
    usdPrice = (
      await getUSDAndNativePrices(currency.contract, amount, now(), {
        onlyUSD: true,
        acceptStalePrice: true,
      })
    ).usdPrice;
  }

  if (totalFeeBps) {
    amount = subFeeWithBps(amount, totalFeeBps);
    if (usdPrice) {
      usdPrice = subFeeWithBps(usdPrice, totalFeeBps);
    }
    if (nativeAmount) {
      nativeAmount = subFeeWithBps(nativeAmount, totalFeeBps);
    }
  }

  return {
    raw: amount,
    decimal: formatPrice(amount, currency.decimals),
    usd: usdPrice ? formatUsd(usdPrice) : null,
    native: nativeAmount ? formatEth(nativeAmount) : null,
  };
};

export const getJoiPriceObject = async (
  prices: {
    gross: {
      amount: string;
      nativeAmount?: string;
      usdAmount?: string;
    };
    net?: {
      amount: string;
      nativeAmount?: string;
      usdAmount?: string;
    };
  },
  currencyAddress: string,
  displayCurrency?: string,
  totalFeeBps?: number,
  currencyChainId?: number,
  currencyAsToken?: boolean
) => {
  let currency: Currency;
  if (displayCurrency && displayCurrency !== currencyAddress) {
    const currentTime = now();
    currency = await getCurrency(displayCurrency);

    // Convert gross price
    const convertedGrossPrice = await getUSDAndCurrencyPrices(
      currencyAddress,
      displayCurrency,
      prices.gross.amount,
      currentTime
    );

    if (convertedGrossPrice.currencyPrice) {
      prices.gross.amount = convertedGrossPrice.currencyPrice;
    }

    // Convert net price
    if (prices.net?.amount) {
      const convertedNetPrice = await getUSDAndCurrencyPrices(
        currencyAddress,
        displayCurrency,
        prices.net.amount,
        currentTime
      );

      if (convertedNetPrice.currencyPrice) {
        prices.net.amount = convertedNetPrice.currencyPrice;
      }
    }
  } else {
    currency = await getCurrency(currencyAddress);
  }

  // Set community tokens native/usd value to 0
  if (
    isWhitelistedCurrency(currency.contract) &&
    !_.includes(Sdk.Common.Addresses.Usdc[config.chainId], currency.contract)
  ) {
    prices.gross.nativeAmount = "0";
    prices.gross.usdAmount = "0";
  }

  return {
    [currencyAsToken ? "token" : "currency"]: {
      contract: currency.contract,
      name: currency.name,
      symbol: currency.symbol,
      decimals: currency.decimals,
      chainId: currencyChainId,
    },
    amount: await getJoiAmountObject(
      currency,
      prices.gross.amount,
      prices.gross.nativeAmount,
      prices.gross.usdAmount
    ),
    netAmount: prices.net
      ? await getJoiAmountObject(
          currency,
          prices.net.amount,
          prices.net.nativeAmount,
          prices.net.usdAmount
        )
      : totalFeeBps && totalFeeBps < 10000
      ? await getJoiAmountObject(
          currency,
          prices.gross.amount,
          prices.gross.nativeAmount,
          prices.gross.usdAmount,
          totalFeeBps
        )
      : undefined,
  };
};

// --- Orders ---

export const JoiAttributeValue = Joi.string().required().allow("");
export const JoiAttributeKeyValueObject = Joi.object({
  key: Joi.string(),
  value: JoiAttributeValue,
});

export const JoiOrderMetadata = Joi.alternatives(
  Joi.object({
    kind: "token",
    data: Joi.object({
      collectionId: Joi.string().allow("", null),
      collectionName: Joi.string().allow("", null),
      tokenName: Joi.string().allow("", null),
      image: Joi.string().allow("", null),
    }),
  }),
  Joi.object({
    kind: "collection",
    data: Joi.object({
      collectionId: Joi.string().allow("", null),
      collectionName: Joi.string().allow("", null),
      image: Joi.string().allow("", null),
    }),
  }),
  Joi.object({
    kind: "attribute",
    data: Joi.object({
      collectionId: Joi.string().allow("", null),
      collectionName: Joi.string().allow("", null),
      attributes: Joi.array().items(JoiAttributeKeyValueObject),
      image: Joi.string().allow("", null),
    }),
  })
);

export const JoiOrderCriteriaCollection = Joi.object({
  id: Joi.string().allow("", null),
  name: Joi.string().allow("", null),
  image: Joi.string().allow("", null),
  isSpam: Joi.boolean().allow("", null),
  isNsfw: Joi.boolean().allow("", null),
});

export const JoiOrderCriteria = Joi.alternatives(
  Joi.object({
    kind: "token",
    data: Joi.object({
      token: Joi.object({
        tokenId: Joi.string().pattern(regex.number),
        name: Joi.string().allow("", null),
        image: Joi.string().allow("", null),
        isSpam: Joi.boolean().allow("", null),
        isNsfw: Joi.boolean().allow("", null),
      }),
      collection: JoiOrderCriteriaCollection,
    }),
  }),
  Joi.object({
    kind: "collection",
    data: Joi.object({
      collection: JoiOrderCriteriaCollection,
    }),
  }),
  Joi.object({
    kind: "attribute",
    data: Joi.object({
      collection: JoiOrderCriteriaCollection,
      attribute: JoiAttributeKeyValueObject,
    }),
  }),
  Joi.object({
    kind: "custom",
    data: Joi.object({
      tokenSetId: Joi.string().allow("", null),
    }),
  })
);

export const JoiOrderDepth = Joi.array().items(
  Joi.object({
    price: Joi.number().unsafe(),
    quantity: Joi.number(),
    uniqueMakers: Joi.number().optional(),
  })
);

export const JoiOrder = Joi.object({
  id: Joi.string().required(),
  kind: Joi.string().required().description("This is the `orderKind`."),
  side: Joi.string().valid("buy", "sell").required().description("Either `buy` or `sell`"),
  status: Joi.string().description(
    "Can be `active`, `inactive`, `expired`, `canceled`, or `filled`"
  ),
  tokenSetId: Joi.string().required(),
  tokenSetSchemaHash: Joi.string().lowercase().pattern(regex.bytes32).required(),
  contract: Joi.string().lowercase().pattern(regex.address),
  contractKind: Joi.string().lowercase(),
  maker: Joi.string().lowercase().pattern(regex.address).required(),
  taker: Joi.string().lowercase().pattern(regex.address).required(),
  price: JoiPrice.description("Return native currency unless displayCurrency contract was passed."),
  validFrom: Joi.number().required(),
  validUntil: Joi.number().required(),
  quantityFilled: Joi.number().unsafe().description("With ERC1155s, quantity can be higher than 1"),
  quantityRemaining: Joi.number()
    .unsafe()
    .description("With ERC1155s, quantity can be higher than 1"),
  dynamicPricing: JoiDynamicPrice.allow(null),
  criteria: JoiOrderCriteria.allow(null).description("Kind can be token, collection, or attribute"),
  source: Joi.object().allow(null),
  feeBps: Joi.number().allow(null),
  feeBreakdown: Joi.array()
    .items(
      Joi.object({
        kind: Joi.string().description("Can be marketplace or royalty"),
        recipient: Joi.string().allow("", null),
        bps: Joi.number(),
      })
    )
    .allow(null),
  expiration: Joi.number().required(),
  isReservoir: Joi.boolean().allow(null),
  isDynamic: Joi.boolean(),
  createdAt: Joi.string().required().description("Time when added to indexer"),
  updatedAt: Joi.string().required().description("Time when updated in indexer"),
  originatedAt: Joi.string().allow(null).description("Time when created by maker"),
  rawData: Joi.object().optional().allow(null),
  isNativeOffChainCancellable: Joi.boolean().optional(),
  depth: JoiOrderDepth,
});

export const JoiActivityOrder = Joi.object({
  id: Joi.string().allow(null),
  side: Joi.string().valid("ask", "bid").allow(null),
  source: Joi.object().allow(null),
  criteria: JoiOrderCriteria.allow(null),
});

export const getJoiDynamicPricingObject = async (
  dynamic: boolean,
  kind: OrderKind,
  normalizeRoyalties: boolean,
  rawData:
    | Sdk.SeaportBase.Types.OrderComponents
    | Sdk.Sudoswap.OrderParams
    | Sdk.Nftx.Types.OrderParams,
  currency?: string,
  missingRoyalties?: []
) => {
  const floorAskCurrency = currency ? currency : Sdk.Common.Addresses.Native[config.chainId];

  // Add missing royalties on top of the raw prices
  const totalMissingRoyalties = normalizeRoyalties
    ? ((missingRoyalties ?? []) as any[])
        .map((mr: any) => bn(mr.amount))
        .reduce((a, b) => a.add(b), bn(0))
    : bn(0);

  if (
    dynamic &&
    (kind === "seaport" ||
      kind === "seaport-v1.4" ||
      kind === "seaport-v1.5" ||
      kind === "seaport-v1.6")
  ) {
    const order = new Sdk.SeaportV14.Order(
      config.chainId,
      rawData as Sdk.SeaportBase.Types.OrderComponents
    );

    // Dutch auction
    return {
      kind: "dutch",
      data: {
        price: {
          start: await getJoiPriceObject(
            {
              gross: {
                amount: bn(order.getMatchingPrice(order.params.startTime))
                  .add(totalMissingRoyalties)
                  .toString(),
              },
            },
            floorAskCurrency
          ),
          end: await getJoiPriceObject(
            {
              gross: {
                amount: bn(order.getMatchingPrice(order.params.endTime))
                  .add(totalMissingRoyalties)
                  .toString(),
              },
            },
            floorAskCurrency
          ),
        },
        time: {
          start: order.params.startTime,
          end: order.params.endTime,
        },
      },
    };
  } else if (kind === "sudoswap" || kind === "sudoswap-v2") {
    // Pool orders
    return {
      kind: "pool",
      data: {
        pool: (rawData as Sdk.Sudoswap.OrderParams).pair,
        prices: await Promise.all(
          ((rawData as Sdk.Sudoswap.OrderParams).extra.prices as string[]).map((price) =>
            getJoiPriceObject(
              {
                gross: {
                  amount: bn(price).add(totalMissingRoyalties).toString(),
                },
              },
              floorAskCurrency
            )
          )
        ),
      },
    };
  } else if (kind === "nftx" || kind === "nftx-v3" || kind === "zora-v4") {
    // Pool orders
    return {
      kind: "pool",
      data: {
        pool: (rawData as Sdk.Nftx.Types.OrderParams).pool,
        prices: await Promise.all(
          (rawData as Sdk.Nftx.Types.OrderParams).extra.prices.map((price) =>
            getJoiPriceObject(
              {
                gross: {
                  amount: bn(price).add(totalMissingRoyalties).toString(),
                },
              },
              floorAskCurrency
            )
          )
        ),
      },
    };
  }
};

export const getJoiOrderDepthObject = async (
  kind: OrderKind,
  currencyPrice: string,
  currency: string,
  maker: string,
  quantityRemaining: number,
  rawData: any,
  totalFeeBps?: number,
  displayCurrency?: string,
  precisionDecimals = 4
) => {
  // By default, show all prices in the native currency of the chain
  if (!displayCurrency) {
    displayCurrency = Sdk.Common.Addresses.Native[config.chainId];
  }

  const scale = (value: number) => Number(value.toFixed(precisionDecimals));

  switch (kind) {
    case "sudoswap":
    case "sudoswap-v2": {
      const order = rawData as Sdk.Sudoswap.OrderParams;
      return Promise.all(
        order.extra.prices.map(async (price) => ({
          price: await getJoiPriceObject(
            {
              gross: {
                amount: price,
              },
            },
            currency,
            displayCurrency,
            totalFeeBps
          ).then((p) => scale((p.netAmount ?? p.amount).decimal)),
          quantity: 1,
          maker,
        }))
      );
    }

    case "zora-v4":
    case "nftx":
    case "nftx-v3": {
      const order = rawData as Sdk.Nftx.Types.OrderParams;
      return Promise.all(
        order.extra.prices.map(async (price) => ({
          price: await getJoiPriceObject(
            {
              gross: {
                amount: price,
              },
            },
            currency,
            displayCurrency,
            totalFeeBps
          ).then((p) => scale((p.netAmount ?? p.amount).decimal)),
          quantity: 1,
          maker,
        }))
      );
    }

    case "blur": {
      if (rawData.pricePoints) {
        // Bids are a special case
        const order = rawData as Sdk.Blur.Types.BlurBidPool;
        return Promise.all(
          order.pricePoints.map(async ({ price, executableSize }) => ({
            price: await getJoiPriceObject(
              {
                gross: {
                  amount: parseEther(price).toString(),
                },
              },
              currency,
              displayCurrency,
              totalFeeBps
            ).then((p) => scale((p.netAmount ?? p.amount).decimal)),
            quantity: Number(executableSize),
            maker,
          }))
        );
      }
    }

    // eslint-disable-next-line no-fallthrough
    default: {
      return [
        {
          price: await getJoiPriceObject(
            {
              gross: {
                amount: currencyPrice,
              },
            },
            currency,
            displayCurrency,
            totalFeeBps
          ).then((p) => scale((p.netAmount ?? p.amount).decimal)),
          quantity: Number(quantityRemaining),
          maker,
        },
      ];
    }
  }
};

export const getJoiOrderObject = async (
  order: {
    id: string;
    kind: OrderKind;
    side: "sell" | "buy";
    status: string;
    tokenSetId: string;
    tokenSetSchemaHash: Buffer;
    contract: Buffer;
    contractKind: string;
    maker: Buffer;
    taker: Buffer;
    prices: {
      gross: {
        amount: string;
        nativeAmount?: string;
        usdAmount?: string;
      };
      net?: {
        amount: string;
        nativeAmount?: string;
        usdAmount?: string;
      };
      currency: Buffer;
    };
    validFrom: string;
    validUntil: string;
    quantityFilled: string;
    quantityRemaining: string;
    criteria: any | null;
    sourceIdInt: number;
    feeBps: number;
    feeBreakdown: any;
    expiration: string;
    isReservoir: boolean;
    isNativeOffChainCancellable: boolean | null;
    createdAt: number;
    updatedAt: number;
    originatedAt: number | null;
    rawData:
      | Sdk.SeaportBase.Types.OrderComponents
      | Sdk.Sudoswap.OrderParams
      | Sdk.Nftx.Types.OrderParams;
    missingRoyalties: any;
    dynamic?: boolean;
    token?: string;
  },
  opts?: {
    normalizeRoyalties: boolean;
    includeRawData: boolean;
    includeDynamicPricing?: boolean;
    includeDepth?: boolean;
    displayCurrency?: string;
    resizeImageUrl?: boolean;
  }
) => {
  const sources = await Sources.getInstance();
  let source: SourcesEntity | undefined;
  if (order.tokenSetId?.startsWith("token")) {
    const [, contract, tokenId] = order.tokenSetId.split(":");
    source = sources.get(Number(order.sourceIdInt), contract, tokenId);
  } else if (order.token) {
    const [contract, tokenId] = order.token.split(":");
    source = sources.get(Number(order.sourceIdInt), contract, tokenId);
  } else {
    source = sources.get(Number(order.sourceIdInt));
  }

  const feeBreakdown = order.feeBreakdown?.map((f: any) => ({
    kind: f.kind,
    recipient: f.recipient,
    bps: f.bps,
  }));

  let feeBps = Number(order.feeBps);
  if (opts?.normalizeRoyalties && order.missingRoyalties) {
    for (let i = 0; i < order.missingRoyalties.length; i++) {
      const index: number = order.feeBreakdown.findIndex(
        (fee: { recipient: string }) => fee.recipient === order.missingRoyalties[i].recipient
      );

      const missingFeeBps = Number(order.missingRoyalties[i].bps);
      feeBps += missingFeeBps;

      if (index !== -1) {
        feeBreakdown[index].bps += missingFeeBps;
      } else {
        feeBreakdown.push({
          bps: missingFeeBps,
          kind: "royalty",
          recipient: order.missingRoyalties[i].recipient,
        });
      }
    }
  }

  const currency = order.prices.currency
    ? fromBuffer(order.prices.currency)
    : order.side === "sell"
    ? Sdk.Common.Addresses.Native[config.chainId]
    : Sdk.Common.Addresses.WNative[config.chainId];

  const criteria = order.criteria;

  if (opts?.resizeImageUrl) {
    if (criteria?.data.token?.image) {
      try {
        criteria.data.token.image = Assets.getResizedImageUrl(
          criteria.data.token.image,
          undefined,
          criteria.data.token.image_version,
          criteria.data.token.image_mime_type
        );
      } catch {
        // Do nothing
      }
    }

    delete criteria?.data.token?.image_version;
    delete criteria?.data.token?.image_mime_type;
  }

  return {
    id: order.id,
    kind: order.kind,
    side: order.side,
    status: order.status,
    tokenSetId: order.tokenSetId,
    tokenSetSchemaHash: fromBuffer(order.tokenSetSchemaHash),
    contract: fromBuffer(order.contract),
    contractKind: order.contractKind,
    maker: fromBuffer(order.maker),
    taker: fromBuffer(order.taker),
    price: await getJoiPriceObject(
      {
        gross: {
          amount: order.prices.gross.amount,
          nativeAmount: order.prices.gross.nativeAmount,
        },
        net: order.prices.net
          ? {
              amount: order.prices.net.amount,
              nativeAmount: order.prices.net.nativeAmount,
            }
          : undefined,
      },
      currency,
      opts?.displayCurrency
    ),
    validFrom: Math.floor(Number(order.validFrom)),
    validUntil: Math.floor(Number(order.validUntil)),
    quantityFilled: Number(order.quantityFilled),
    quantityRemaining: Number(order.quantityRemaining),
    dynamicPricing: opts?.includeDynamicPricing
      ? await getJoiDynamicPricingObject(
          Boolean(order.dynamic),
          order.kind,
          opts?.normalizeRoyalties || false,
          order.rawData,
          currency,
          order.missingRoyalties ? order.missingRoyalties : undefined
        )
      : order.dynamic !== undefined
      ? null
      : undefined,
    criteria,
    source: getJoiSourceObject(source),
    feeBps: Number(feeBps.toString()),
    feeBreakdown,
    expiration: Math.floor(Number(order.expiration)),
    isReservoir: order.isReservoir,
    isDynamic:
      order.dynamic !== undefined ? Boolean(order.dynamic || order.kind === "sudoswap") : undefined,
    createdAt: new Date(order.createdAt * 1000).toISOString(),
    updatedAt: new Date(order.updatedAt * 1000).toISOString(),
    originatedAt: order.originatedAt ? new Date(order.originatedAt).toISOString() : null,
    rawData: opts?.includeRawData ? order.rawData : undefined,
    isNativeOffChainCancellable:
      order.isNativeOffChainCancellable === null && opts?.includeRawData
        ? isOrderNativeOffChainCancellable(order.rawData)
        : order.isNativeOffChainCancellable !== null
        ? order.isNativeOffChainCancellable
        : undefined,
    depth: opts?.includeDepth
      ? (
          await getJoiOrderDepthObject(
            order.kind,
            order.prices.gross.amount,
            currency,
            fromBuffer(order.maker),
            Number(order.quantityRemaining),
            order.rawData,
            order.side === "buy" ? feeBps : undefined,
            opts?.displayCurrency
          )
        ).map((d) => ({ price: d.price, quantity: d.quantity }))
      : undefined,
  };
};

export const getJoiActivityOrderObject = async (order: {
  id: string | null;
  side: string | null;
  sourceIdInt: number | null | undefined;
  criteria: Record<string, unknown> | null | undefined;
}) => {
  const sources = await Sources.getInstance();
  const orderSource = order.sourceIdInt ? sources.get(order.sourceIdInt) : undefined;

  return {
    id: order.id,
    side: order.side ? (order.side === "sell" ? "ask" : "bid") : undefined,
    source: getJoiSourceObject(orderSource, false),
    criteria: order.criteria,
  };
};

// --- Sales ---

export const JoiFeeBreakdown = Joi.object({
  kind: Joi.string(),
  bps: Joi.number(),
  recipient: Joi.string(),
  source: Joi.string().optional(),
  rawAmount: Joi.string(),
});

export const JoiSale = Joi.object({
  id: Joi.string().description("Deprecated. Use `saleId` instead."),
  saleId: Joi.string().description("Unique identifier made from txn hash, price, etc."),
  token: Joi.object({
    contract: Joi.string().lowercase().pattern(regex.address),
    tokenId: Joi.string().pattern(regex.number),
    name: Joi.string().allow("", null),
    image: Joi.string().allow("", null),
    collection: Joi.object({
      id: Joi.string().allow(null),
      name: Joi.string().allow("", null),
    }),
  }).optional(),
  orderSource: Joi.string().allow("", null).optional(),
  orderSide: Joi.string().valid("ask", "bid").optional().description("Can be `ask` or `bid`."),
  orderKind: Joi.string().optional(),
  orderId: Joi.string().allow(null).optional(),
  orderIsReservoir: Joi.boolean().optional(),
  from: Joi.string().lowercase().pattern(regex.address).optional(),
  to: Joi.string().lowercase().pattern(regex.address).optional(),
  amount: Joi.string().optional(),
  fillSource: Joi.string().allow(null).optional(),
  block: Joi.number().optional(),
  txHash: Joi.string().lowercase().pattern(regex.bytes32).optional(),
  logIndex: Joi.number().optional(),
  batchIndex: Joi.number().optional(),
  timestamp: Joi.number().description("Time added on the blockchain"),
  price: JoiPrice,
  washTradingScore: Joi.number().optional(),
  royaltyFeeBps: Joi.number().optional(),
  marketplaceFeeBps: Joi.number().optional(),
  paidFullRoyalty: Joi.boolean().optional(),
  feeBreakdown: Joi.array()
    .items(JoiFeeBreakdown)
    .optional()
    .description("`kind` can be `marketplace` or `royalty`"),
  comment: Joi.string().allow("", null).optional(),
  isDeleted: Joi.boolean().optional(),
  createdAt: Joi.string().optional().description("Time when added to indexer"),
  updatedAt: Joi.string().optional().description("Time when updated in indexer"),
});

export const feeInfoIsValid = (
  royaltyFeeBps: number | undefined,
  marketplaceFeeBps: number | undefined
) => {
  return (royaltyFeeBps ?? 0) + (marketplaceFeeBps ?? 0) < 10000;
};

export const getFeeValue = (feeValue: any, validFees: boolean) => {
  return feeValue !== null && validFees ? feeValue : undefined;
};

export const getFeeBreakdown = async (
  royaltyFeeBreakdown: any,
  marketplaceFeeBreakdown: any,
  validFees: boolean,
  totalAmount: string
) => {
  const feeRecipients = await FeeRecipients.getInstance();
  const feeBreakdown: undefined | any[] =
    (royaltyFeeBreakdown !== null || marketplaceFeeBreakdown !== null) && validFees
      ? [].concat(
          (royaltyFeeBreakdown ?? []).map((detail: any) => {
            return {
              kind: "royalty",
              ...detail,
            };
          }),
          (marketplaceFeeBreakdown ?? []).map((detail: any) => {
            return {
              kind: "marketplace",
              ...detail,
            };
          })
        )
      : undefined;

  const sources = await Sources.getInstance();

  if (feeBreakdown) {
    for (let i = 0; i < feeBreakdown.length; i++) {
      const feeBreak = feeBreakdown[i];

      const feeEntity = feeRecipients.getByAddress(feeBreak.recipient, feeBreak.kind);
      feeBreak.rawAmount = bn(totalAmount).mul(feeBreak.bps).div(bn(10000)).toString();

      const orderSource = feeEntity?.sourceId ? sources.get(Number(feeEntity.sourceId)) : undefined;
      feeBreak.source = orderSource?.domain ?? undefined;
    }
  }

  return feeBreakdown;
};

export const getJoiSaleObject = async (sale: {
  prices: {
    gross: {
      amount: string;
      nativeAmount?: string;
      usdAmount?: string;
    };
    net?: {
      amount: string;
      nativeAmount?: string;
      usdAmount?: string;
    };
  };
  fees: {
    royaltyFeeBps?: number;
    marketplaceFeeBps?: number;
    paidFullRoyalty?: boolean;
    royaltyFeeBreakdown?: any;
    marketplaceFeeBreakdown?: any;
  };
  currencyAddress: Buffer;
  timestamp: number;
  contract?: Buffer;
  tokenId?: string;
  name?: string;
  image?: string | string[] | null;
  collectionId?: string;
  collectionName?: string;
  washTradingScore?: number;
  orderId?: string;
  orderSourceId?: number;
  orderSide?: string;
  orderKind?: OrderKind;
  maker?: Buffer;
  taker?: Buffer;
  amount?: number;
  fillSourceId?: number;
  block?: number;
  txHash?: Buffer;
  logIndex?: number;
  batchIndex?: number;
  comment?: string;
  isDeleted?: boolean;
  updatedAt?: string;
  createdAt?: string;
}) => {
  const currency = await getCurrency(fromBuffer(sale.currencyAddress));
  const lastSaleFeeInfoIsValid = feeInfoIsValid(
    sale.fees.royaltyFeeBps,
    sale.fees.marketplaceFeeBps
  );
  const sources = await Sources.getInstance();
  const orderSource =
    sale.orderSourceId !== null ? sources.get(Number(sale.orderSourceId)) : undefined;
  const fillSource =
    sale.fillSourceId !== null ? sources.get(Number(sale.fillSourceId)) : undefined;
  const totalFeeBps = (sale.fees.royaltyFeeBps ?? 0) + (sale.fees.marketplaceFeeBps ?? 0);

  return {
    id:
      sale.txHash &&
      crypto
        .createHash("sha256")
        .update(`${fromBuffer(sale.txHash)}${sale.logIndex}${sale.batchIndex}`)
        .digest("hex"),
    saleId:
      sale.txHash &&
      crypto
        .createHash("sha256")
        .update(
          `${fromBuffer(sale.txHash)}${sale.maker}${sale.taker}${sale.contract}${sale.tokenId}${
            sale.prices.gross.nativeAmount
          }`
        )
        .digest("hex"),
    token:
      sale.contract !== undefined && sale.tokenId !== undefined
        ? {
            contract: fromBuffer(sale.contract),
            tokenId: sale.tokenId,
            name: sale.name ?? null,
            image: sale.image,
            collection: {
              id: sale.collectionId ?? null,
              name: sale.collectionName ?? null,
            },
          }
        : undefined,
    orderId: sale.orderId,
    orderSource: orderSource?.domain ?? null,
    orderSide: sale.orderSide && (sale.orderSide === "sell" ? "ask" : "bid"),
    orderKind: sale.orderKind,
    from:
      sale.maker &&
      sale.taker &&
      (sale.orderSide === "sell" ? fromBuffer(sale.maker) : fromBuffer(sale.taker)),
    to:
      sale.maker &&
      sale.taker &&
      (sale.orderSide === "sell" ? fromBuffer(sale.taker) : fromBuffer(sale.maker)),
    amount: sale.amount,
    fillSource: fillSource?.domain ?? orderSource?.domain ?? null,
    block: sale.block,
    txHash: sale.txHash && fromBuffer(sale.txHash),
    logIndex: sale.logIndex,
    batchIndex: sale.batchIndex,
    timestamp: sale.timestamp,
    price: {
      currency: {
        contract: currency.contract,
        name: currency.name,
        symbol: currency.symbol,
        decimals: currency.decimals,
      },
      amount: await getJoiAmountObject(
        currency,
        sale.prices.gross.amount,
        sale.prices.gross.nativeAmount,
        sale.prices.gross.usdAmount
      ),
      netAmount: sale.prices.net
        ? await getJoiAmountObject(
            currency,
            sale.prices.net.amount,
            sale.prices.net.nativeAmount,
            sale.prices.net.usdAmount
          )
        : totalFeeBps && totalFeeBps < 10000
        ? await getJoiAmountObject(
            currency,
            sale.prices.gross.amount,
            sale.prices.gross.nativeAmount,
            sale.prices.gross.usdAmount,
            totalFeeBps
          )
        : undefined,
    },
    washTradingScore: sale.washTradingScore,
    royaltyFeeBps: getFeeValue(sale.fees.royaltyFeeBps, lastSaleFeeInfoIsValid),
    marketplaceFeeBps: getFeeValue(sale.fees.marketplaceFeeBps, lastSaleFeeInfoIsValid),
    paidFullRoyalty: getFeeValue(sale.fees.paidFullRoyalty, lastSaleFeeInfoIsValid),
    feeBreakdown: await getFeeBreakdown(
      sale.fees.royaltyFeeBreakdown,
      sale.fees.marketplaceFeeBreakdown,
      lastSaleFeeInfoIsValid,
      sale.prices.gross.amount
    ),
    comment: sale.comment,
    isDeleted: sale.isDeleted,
    createdAt: sale.createdAt,
    updatedAt: sale.updatedAt,
  };
};

// --- Fees ---

export const JoiExecuteFee = Joi.object({
  kind: Joi.string(),
  recipient: Joi.string().pattern(regex.address),
  bps: Joi.number().unsafe(),
  amount: Joi.number().unsafe(),
  rawAmount: Joi.string().pattern(regex.number),
});

// --- Sources ---

export const JoiSource = Joi.object({
  id: Joi.string().allow(null),
  domain: Joi.string().allow(null),
  name: Joi.string().allow(null),
  icon: Joi.string().allow(null),
  url: Joi.string().allow(null),
});

export const getJoiSourceObject = (source: SourcesEntity | undefined, full = true) => {
  return source
    ? {
        id: full ? source.address : undefined,
        domain: source.domain,
        name: source.getTitle(),
        icon: source.getIcon(),
        url: full ? source.metadata.url : undefined,
      }
    : null;
};

// --- Collections ---

export const getJoiCollectionObject = (
  collection: any,
  metadataDisabled: boolean,
  contract?: string
) => {
  if (metadataDisabled) {
    const collectionContract = collection.primaryContract ?? collection.contract ?? contract;
    const metadataDisabledCollection: any = {
      id: collectionContract,
      name: collectionContract,
      slug: collectionContract,
      description: null,
      metadata: null,
      image: null,
      imageUrl: null,
      sampleImages: [],
      banner: null,
      discordUrl: null,
      externalUrl: null,
      twitterUsername: null,
      openseaVerificationStatus: null,
      magicedenVerificationStatus: null,
      community: null,
      tokenIdRange: null,
      tokenSetId: `contract:${collectionContract}`,
      royalties: null,
      newRoyalties: null,
    };

    for (const key in metadataDisabledCollection) {
      if (collection[key] !== undefined) {
        collection[key] = metadataDisabledCollection[key];
      }
    }

    if (collection.floorAsk?.token) {
      collection.floorAsk.token = getJoiTokenObject(collection.floorAsk.token, true, true);
    }

    if (collection.recentSales) {
      for (const sale of collection.recentSales) {
        if (sale.token) {
          sale.token = getJoiTokenObject(sale.token, true, true);
        }
        if (sale.collection) {
          sale.collection = getJoiCollectionObject(sale.collection, true, contract);
        }
      }
    }
  }

  return collection;
};

// -- Tokens --

export const getJoiTokenObject = (
  token: any,
  tokenMetadataDisabled: boolean,
  collectionMetadataDisabled: boolean
) => {
  if (tokenMetadataDisabled || collectionMetadataDisabled) {
    const metadataDisabledToken: any = {
      name: null,
      isFlagged: false,
      media: null,
      description: null,
      image: null,
      imageSmall: null,
      imageLarge: null,
      metadata: null,
      attributes: [],
    };

    for (const key in metadataDisabledToken) {
      if (token[key] !== undefined) {
        token[key] = metadataDisabledToken[key];
      }
    }

    if (collectionMetadataDisabled && token.collection) {
      token.collection = getJoiCollectionObject(
        token.collection,
        collectionMetadataDisabled,
        token.contract
      );
    }
  }

  return token;
};

// -- Activities --

export const getJoiActivityObject = (
  activity: any,
  tokenMetadataDisabled: boolean,
  collectionMetadataDisabled: { [id: string]: boolean }
) => {
  if (tokenMetadataDisabled || collectionMetadataDisabled[activity.collection?.collectionId]) {
    if (activity.token?.tokenName) {
      activity.token.tokenName = null;
    }
    if (activity.token?.tokenImage) {
      activity.token.tokenImage = null;
    }
    if (activity.token?.tokenMedia) {
      activity.token.tokenMedia = null;
    }
  }

  if (collectionMetadataDisabled[activity.collection?.collectionId]) {
    if (activity.collection?.collectionName) {
      activity.collection.collectionName = activity.contract;
    }
    if (activity.collection?.collectionImage) {
      activity.collection.collectionImage = null;
    }
  }

  if (activity.token) {
    activity.token.isNsfw = Boolean(activity.token?.isNsfw);
  }

  if (activity.collection) {
    activity.collection.isNsfw = Boolean(activity.collection?.isNsfw);
  }

  return activity;
};

export const getJoiActivityTokenObj = (
  activity: ActivityDocument,
  tokenMetadata: any,
  tokenMetadataDisabled: boolean
) => {
  let tokenName = null;
  let tokenImage = null;

  if (!tokenMetadataDisabled) {
    tokenName = (tokenMetadata ? tokenMetadata.name : activity.token?.name) || null;

    const tokenImageUrl = tokenMetadata ? tokenMetadata.image : activity.token?.image;

    if (tokenImageUrl) {
      tokenImage = Assets.getResizedImageUrl(
        tokenImageUrl,
        undefined,
        tokenMetadata?.image_version,
        tokenMetadata?.image_mime_type
      );
    }
  }

  return {
    tokenId: activity.token?.id,
    name: tokenName,
    image: tokenImage,
    isSpam: activity.collection?.isSpam || activity.token?.isSpam,
    isNsfw: activity.collection?.isNsfw || activity.token?.isNsfw,
  };
};

export const getJoiActivityCollectionObj = (
  activity: ActivityDocument,
  collectionMetadata: any,
  collectionMetadataDisabled: boolean
) => {
  let collectionName = null;
  let collectionImage = null;

  if (!collectionMetadataDisabled) {
    collectionName =
      (collectionMetadata ? collectionMetadata.name : activity.collection?.name) || null;

    const collectionImageUrl = collectionMetadata
      ? collectionMetadata.image
      : activity.collection?.image;

    if (collectionImageUrl) {
      const collectionImageVersion = collectionMetadata
        ? collectionMetadata.image_version
        : activity.collection?.imageVersion;

      collectionImage = Assets.getResizedImageUrl(
        collectionImageUrl,
        undefined,
        collectionImageVersion
      );
    }
  }

  return {
    id: activity.collection?.id,
    name: collectionName,
    image: collectionImage,
    isSpam: activity.collection?.isSpam,
    isNsfw: activity.collection?.isNsfw,
  };
};

export const getJoiActivityOrderObj = async (
  activity: ActivityDocument,
  tokenMetadata: any,
  collectionMetadata: any,
  collectionMetadataDisabled: boolean
) => {
  let orderCriteria;

  if (activity.order?.criteria) {
    orderCriteria = {
      kind: activity.order.criteria.kind,
      data: {
        collection: getJoiCollectionObject(
          {
            id: activity.collection?.id,
            name: collectionMetadata ? collectionMetadata.name : activity.collection?.name,
            image: collectionMetadata ? collectionMetadata.image : activity.collection?.image,
            isSpam: activity.collection?.isSpam,
            isNsfw: activity.collection?.isNsfw,
          },
          collectionMetadataDisabled,
          activity.contract
        ),
      },
    };

    if (activity.order.criteria.kind === "token") {
      (orderCriteria as any).data.token = getJoiTokenObject(
        {
          tokenId: activity.token?.id,
          name: tokenMetadata ? tokenMetadata.name : activity.token?.name,
          image: tokenMetadata ? tokenMetadata.image : activity.token?.image,
          isSpam: activity.collection?.isSpam || activity.token?.isSpam,
          isNsfw: activity.collection?.isNsfw || activity.token?.isNsfw,
        },
        tokenMetadata?.metadata_disabled || collectionMetadataDisabled,
        collectionMetadataDisabled
      );
    }

    if (activity.order.criteria.kind === "attribute") {
      (orderCriteria as any).data.attribute = activity.order.criteria.data.attribute;
    }
  }

  const order = activity.order?.id
    ? await getJoiActivityOrderObject({
        id: activity.order.id,
        side: activity.order.side,
        sourceIdInt: activity.order.sourceId,
        criteria: orderCriteria,
      })
    : undefined;

  return order;
};

export const getJoiActivityObj = async (
  activity: ActivityDocument,
  tokenMetadata: any,
  collectionMetadata: any,
  tokenMetadataDisabled: boolean,
  collectionMetadataDisabled: boolean
) => {
  switch (activity.type) {
    case ActivityType.bridge:
    case ActivityType.swap:
      return await getJoiSwapActivityObj(activity);
    case ActivityType.tokenTransfer:
      return await getJoiFtTransferActivityObj(activity);
    case ActivityType.contractCall:
      return await getJoiContractCallActivityObj(activity);
    case ActivityType.nftTransfer:
      return await getJoiNftTransferActivityObj(
        activity,
        tokenMetadata,
        collectionMetadata,
        tokenMetadataDisabled,
        collectionMetadataDisabled
      );
    case ActivityType.nftSale:
      return await getJoiSaleActivityObj(
        activity,
        tokenMetadata,
        collectionMetadata,
        tokenMetadataDisabled,
        collectionMetadataDisabled
      );
    case ActivityType.nftMint:
      return await getJoiMintActivityObj(
        activity,
        tokenMetadata,
        collectionMetadata,
        tokenMetadataDisabled,
        collectionMetadataDisabled
      );
    case ActivityType.nftAsk:
    case ActivityType.nftAskCancel:
    case ActivityType.nftBid:
    case ActivityType.nftBidCancel:
      return await getJoiOrderActivityObj(
        activity,
        tokenMetadata,
        collectionMetadata,
        tokenMetadataDisabled,
        collectionMetadataDisabled
      );
    default:
      return await getJoiBaseActivityObj(activity);
  }
};

export const getJoiContractCallActivityObj = async (activity: ActivityDocument) => {
  const baseActivityObj = await getJoiBaseActivityObj(activity);

  return {
    ...baseActivityObj,
    data: {
      gasPrice: activity.event?.gasPrice,
      value: activity.event?.value,
      txHash: activity.event?.txHash,
      functionSelector: activity.event?.functionSelector,
    },
  };
};

export const getJoiFtTransferActivityObj = async (activity: ActivityDocument) => {
  const baseActivityObj = await getJoiBaseActivityObj(activity);

  const currency = await getCurrency(activity.contract);

  const token = {
    contract: activity.contract,
    metadata: {
      image: currency?.metadata?.image
        ? Assets.getResizedImageUrl(currency.metadata.image, ImageSize.small)
        : undefined,
    },
    name: currency?.name,
    symbol: currency?.symbol,
    decimals: currency?.decimals,
    totalSupply: currency?.totalSupply,
  };

  return {
    ...baseActivityObj,
    data: {
      token,
      amount: activity.pricing?.price
        ? {
            raw: activity.pricing.price,
            decimal: formatPrice(activity.pricing.price, token.decimals),
            usd: activity.pricing.usdPrice ? formatUsd(activity.pricing.usdPrice) : undefined,
          }
        : null,
      txHash: activity.event?.txHash,
    },
  };
};

export const getJoiNftTransferActivityObj = async (
  activity: ActivityDocument,
  tokenMetadata: any,
  collectionMetadata: any,
  tokenMetadataDisabled: boolean,
  collectionMetadataDisabled: boolean
) => {
  const baseActivityObj = await getJoiBaseActivityObj(activity);

  return {
    ...baseActivityObj,
    data: {
      contract: activity.contract,
      nft: activity.token?.id
        ? getJoiActivityTokenObj(
            activity,
            tokenMetadata,
            tokenMetadataDisabled || collectionMetadataDisabled
          )
        : null,
      collection: activity.collection?.id
        ? getJoiActivityCollectionObj(activity, collectionMetadata, collectionMetadataDisabled)
        : null,
      amount: activity.amount,
      txHash: activity.event?.txHash,
      isAirdrop: activity.event?.transferIsAirdrop,
    },
  };
};

export const getJoiSaleActivityObj = async (
  activity: ActivityDocument,
  tokenMetadata: any,
  collectionMetadata: any,
  tokenMetadataDisabled: boolean,
  collectionMetadataDisabled: boolean
) => {
  const currency = activity.pricing?.currency
    ? activity.pricing.currency
    : Sdk.Common.Addresses.Native[config.chainId];

  const sources = await Sources.getInstance();

  const fillSource = activity.event?.fillSourceId
    ? sources.get(activity.event?.fillSourceId)
    : undefined;

  const baseActivityObj = await getJoiBaseActivityObj(activity);

  return {
    ...baseActivityObj,
    data: {
      contract: activity.contract,
      nft: activity.token?.id
        ? getJoiActivityTokenObj(
            activity,
            tokenMetadata,
            tokenMetadataDisabled || collectionMetadataDisabled
          )
        : null,
      collection: activity.collection?.id
        ? getJoiActivityCollectionObj(activity, collectionMetadata, collectionMetadataDisabled)
        : null,
      order: activity.order?.id
        ? await getJoiActivityOrderObj(
            activity,
            tokenMetadata,
            collectionMetadata,
            collectionMetadataDisabled
          )
        : null,
      price: activity.pricing?.price
        ? await getJoiPriceObject(
            {
              gross: {
                amount: String(activity.pricing?.currencyPrice ?? activity.pricing?.price),
                nativeAmount: String(activity.pricing?.price),
              },
            },
            currency,
            undefined,
            undefined,
            undefined,
            true
          )
        : undefined,
      amount: activity.amount,
      txHash: activity.event?.txHash,
      fillSource: fillSource ? getJoiSourceObject(fillSource, false) : null,
    },
  };
};

export const getJoiMintActivityObj = async (
  activity: ActivityDocument,
  tokenMetadata: any,
  collectionMetadata: any,
  tokenMetadataDisabled: boolean,
  collectionMetadataDisabled: boolean
) => {
  const currency = activity.pricing?.currency
    ? activity.pricing.currency
    : Sdk.Common.Addresses.Native[config.chainId];

  const baseActivityObj = await getJoiBaseActivityObj(activity);

  return {
    ...baseActivityObj,
    data: {
      contract: activity.contract,
      nft: activity.token?.id
        ? getJoiActivityTokenObj(
            activity,
            tokenMetadata,
            tokenMetadataDisabled || collectionMetadataDisabled
          )
        : null,
      collection: activity.collection?.id
        ? getJoiActivityCollectionObj(activity, collectionMetadata, collectionMetadataDisabled)
        : null,
      price: activity.pricing?.price
        ? await getJoiPriceObject(
            {
              gross: {
                amount: String(activity.pricing?.currencyPrice ?? activity.pricing?.price),
                nativeAmount: String(activity.pricing?.price),
              },
            },
            currency,
            undefined,
            undefined,
            undefined,
            true
          )
        : undefined,
      amount: activity.amount,
      comment: activity.event?.comment,
      txHash: activity.event?.txHash,
    },
  };
};

export const getJoiOrderActivityObj = async (
  activity: ActivityDocument,
  tokenMetadata: any,
  collectionMetadata: any,
  tokenMetadataDisabled: boolean,
  collectionMetadataDisabled: boolean
) => {
  const currency = activity.pricing?.currency
    ? activity.pricing.currency
    : Sdk.Common.Addresses.Native[config.chainId];

  const baseActivityObj = await getJoiBaseActivityObj(activity);

  return {
    ...baseActivityObj,
    data: {
      contract: activity.contract,
      nft: activity.token?.id
        ? getJoiActivityTokenObj(
            activity,
            tokenMetadata,
            tokenMetadataDisabled || collectionMetadataDisabled
          )
        : null,
      collection: activity.collection?.id
        ? getJoiActivityCollectionObj(activity, collectionMetadata, collectionMetadataDisabled)
        : null,
      price: activity.pricing?.price
        ? await getJoiPriceObject(
            {
              gross: {
                amount: String(activity.pricing?.currencyPrice ?? activity.pricing?.price),
                nativeAmount: String(activity.pricing?.price),
              },
            },
            currency,
            undefined,
            undefined,
            undefined,
            true
          )
        : undefined,
      amount: activity.amount,
    },
  };
};

export const getJoiSwapActivityObj = async (activity: ActivityDocument) => {
  const baseActivityObj = await getJoiBaseActivityObj(activity);

  let fromCurrency;

  if (activity.fromCurrency) {
    const currency = await getCurrency(activity.fromCurrency);

    fromCurrency = {
      contract: activity.fromCurrency,
      metadata: {
        image: currency?.metadata?.image
          ? Assets.getResizedImageUrl(currency.metadata.image, ImageSize.small)
          : undefined,
      },
      name: currency?.name,
      symbol: currency?.symbol,
      decimals: currency?.decimals,
      totalSupply: currency?.totalSupply,
    };
  } else {
    fromCurrency = activity.swap?.fromCurrency.currency;
  }

  let toCurrency;

  if (activity.toCurrency) {
    const currency = await getCurrency(activity.toCurrency);

    toCurrency = {
      contract: activity.toCurrency,
      metadata: {
        image: currency?.metadata?.image
          ? Assets.getResizedImageUrl(currency.metadata.image, ImageSize.small)
          : undefined,
      },
      name: currency?.name,
      symbol: currency?.symbol,
      decimals: currency?.decimals,
      totalSupply: currency?.totalSupply,
    };
  } else {
    toCurrency = activity.swap?.toCurrency.currency;
  }

  return {
    ...baseActivityObj,
    data: {
      fromToken: {
        chainId: activity.swap?.fromCurrency.chainId,
        txHash: activity.swap?.fromCurrency.txHash,
        amount: activity.swap?.fromCurrency.amount,
        token: fromCurrency,
      },
      toToken: {
        chainId: activity.swap?.toCurrency.chainId,
        txHash: activity.swap?.toCurrency.txHash,
        amount: activity.swap?.toCurrency.amount,
        token: toCurrency,
      },
    },
  };
};

export const getJoiBaseActivityObj = async (activity: ActivityDocument) => {
  return {
    type: JoiActivityTypeMapping[activity.type] ?? activity.type,
    fromAddress: activity.fromAddress,
    toAddress: activity.toAddress ?? null,
    timestamp: new Date(activity.timestamp * 1000).toISOString(),
  };
};
