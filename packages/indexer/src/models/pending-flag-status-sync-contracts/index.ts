import _ from "lodash";
import { redis } from "@/common/redis";
import { getOpenseaChainName } from "@/config/network";
import { config } from "@/config/index";

export type PendingFlagStatusSync = {
  contract: string;
  continuation: string | null;
  collectionId: string;
};

/**
 * Class that manage redis list of tokens, pending metadata sync
 */
export class PendingFlagStatusSyncContracts {
  public static key = "pending-flag-status-sync-contract";

  public static async add(syncCollection: PendingFlagStatusSync[], prioritized = false) {
    if (!getOpenseaChainName() || config.isTestnet) {
      return;
    }

    if (prioritized) {
      return await redis.lpush(
        this.key,
        _.map(syncCollection, (token) => JSON.stringify(token))
      );
    } else {
      return await redis.rpush(
        this.key,
        _.map(syncCollection, (token) => JSON.stringify(token))
      );
    }
  }

  public static async get(count = 20): Promise<PendingFlagStatusSync[]> {
    const syncCollections = await redis.lpop(this.key, count);
    if (syncCollections) {
      return _.map(
        syncCollections,
        (syncCollection) => JSON.parse(syncCollection) as PendingFlagStatusSync
      );
    }

    return [];
  }

  public static async count(): Promise<number> {
    return await redis.llen(this.key);
  }
}
