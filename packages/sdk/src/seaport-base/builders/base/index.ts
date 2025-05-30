import { BigNumberish } from "@ethersproject/bignumber";
import { AddressZero, HashZero } from "@ethersproject/constants";

import { IOrder } from "../../order";
import * as Types from "../../types";
import { bn, getCurrentTimestamp, getRandomBytes } from "../../../utils";

export interface BaseBuildParams {
  offerer: string;
  side: "buy" | "sell";
  tokenKind: "erc721" | "erc1155";
  contract: string;
  price: BigNumberish;
  endPrice?: BigNumberish;
  amount?: BigNumberish;
  paymentToken: string;
  fees?: {
    recipient: string;
    amount: BigNumberish;
    endAmount?: BigNumberish;
  }[];
  counter: BigNumberish;
  taker?: string;
  orderType?: number;
  zone?: string;
  zoneHash?: string;
  conduitKey?: string;
  salt?: BigNumberish;
  startTime?: number;
  endTime?: number;
  signature?: string;
  extraData?: string;
}

export interface BaseOrderInfo {
  tokenKind: "erc721" | "erc1155";
  side: "sell" | "buy";
  contract: string;
  tokenId?: string;
  merkleRoot?: string;
  taker: string;
  amount: string;
  paymentToken: string;
  price: string;
  endPrice?: string;
  fees: {
    recipient: string;
    amount: BigNumberish;
    endAmount?: BigNumberish;
  }[];
  // For supporting dutch auctions
  isDynamic?: boolean;
}

export abstract class BaseBuilder {
  public chainId: number;

  constructor(chainId: number) {
    this.chainId = chainId;
  }

  protected defaultInitialize(params: BaseBuildParams) {
    // Default listing time is 5 minutes in the past to allow for any
    // time discrepancies when checking the order's validity on-chain
    params.startTime = params.startTime ?? getCurrentTimestamp(-5 * 60);
    params.endTime = params.endTime ?? 0;
    params.conduitKey = params.conduitKey ?? HashZero;
    params.zone = params.zone ?? AddressZero;
    params.zoneHash = params.zoneHash ?? HashZero;
    params.salt = params.salt ?? getRandomBytes();
    params.signature = params.signature ?? HashZero;
  }

  protected getBaseInfo(order: IOrder) {
    // Offer should always consists of a single item
    if (order.params.offer.length !== 1) {
      throw new Error("Invalid offer");
    }
    // Must have at least one consideration
    if (order.params.consideration.length < 1) {
      throw new Error("Invalid consideration");
    }

    // Contract orders are not supported
    if (order.params.orderType === Types.OrderType.CONTRACT) {
      throw new Error("Contract orders not supported");
    }

    const offerItem = order.params.offer[0];

    let side: "sell" | "buy";
    if (
      offerItem.itemType === Types.ItemType.ERC721 ||
      offerItem.itemType === Types.ItemType.ERC1155
    ) {
      side = "sell";
    } else if (offerItem.itemType === Types.ItemType.ERC20) {
      side = "buy";
    } else {
      throw new Error("Invalid item");
    }

    // A dynamic order has at least one item with different start/end amounts
    const dynamicConsideration = order.params.consideration.some(
      (c) => c.startAmount !== c.endAmount
    );
    const dynamicOffer = order.params.offer.some((c) => c.startAmount !== c.endAmount);
    const isDynamic = dynamicConsideration || dynamicOffer;

    // For a dynamic order, all consideration or offer items must have the same direction
    if (isDynamic) {
      if (
        dynamicConsideration &&
        !order.params.consideration.every((c) => bn(c.startAmount).gte(c.endAmount))
      ) {
        throw new Error("Invalid item");
      }
      if (dynamicOffer && !order.params.offer.every((c) => bn(c.startAmount).lte(c.endAmount))) {
        throw new Error("Invalid item");
      }
    }

    return { side, isDynamic };
  }

  protected baseIsValid(order: IOrder): boolean {
    for (let i = 0; i < order.params.offer.length; i++) {
      if (order.params.offer[i].startAmount == "0" || order.params.offer[i].endAmount == "0") {
        return false;
      }
    }

    for (let i = 0; i < order.params.consideration.length; i++) {
      if (
        order.params.consideration[i].startAmount == "0" ||
        order.params.consideration[i].endAmount == "0"
      ) {
        return false;
      }
    }

    return true;
  }

  public abstract getInfo(order: IOrder): BaseOrderInfo | undefined;
  public abstract isValid<T extends IOrder>(
    order: IOrder,
    orderBuilder: { new (chainId: number, params: Types.OrderComponents): T }
  ): boolean;
  public abstract build<T extends IOrder>(
    params: BaseBuildParams,
    orderBuilder: { new (chainId: number, params: Types.OrderComponents): T }
  ): T;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public abstract buildMatching(order: IOrder, data: any): Types.MatchParams;
}
