import { idb, ridb } from "@/common/db";
import { AbstractRabbitMqJobHandler, BackoffStrategy } from "@/jobs/abstract-rabbit-mq-job-handler";
import { Collections } from "@/models/collections";
import { acquireLock, getLockExpiration } from "@/common/redis";
import { Tokens } from "@/models/tokens";
import { toBuffer } from "@/common/utils";
import _ from "lodash";

export type RecalcOwnerCountQueueJobPayload =
  | {
      context?: string;
      kind: "contactAndTokenId";
      data: {
        contract: string;
        tokenId: string;
      };
    }
  | {
      context?: string;
      kind: "collectionId";
      data: {
        collectionId: string;
      };
    };

export default class RecalcOwnerCountQueueJob extends AbstractRabbitMqJobHandler {
  queueName = "collection-recalc-owner-count-queue";
  maxRetries = 10;
  concurrency = 10;
  timeout = 5 * 60 * 1000;
  backoff = {
    type: "exponential",
    delay: 20000,
  } as BackoffStrategy;

  public async process(payload: RecalcOwnerCountQueueJobPayload) {
    const { kind, data } = payload;
    let collection;

    if (kind === "contactAndTokenId") {
      const { contract, tokenId } = data;

      collection = await Tokens.getCollection(contract, tokenId);
    } else {
      collection = await Collections.getById(data.collectionId);
    }

    if (collection) {
      const calcLockExpiration =
        collection.tokenCount > 30000
          ? collection.tokenCount > 100000
            ? 60 * 60
            : 60 * 15
          : 60 * 5;
      const acquiredCalcLock = await acquireLock(
        this.getCalcLockName(collection.id),
        calcLockExpiration
      );

      if (acquiredCalcLock) {
        let ownerCountQuery;

        if (collection.tokenIdRange) {
          ownerCountQuery = `
                       SELECT 
                            COUNT(
                              DISTINCT(owner)
                            ) AS "ownerCount" 
                          FROM  nft_balances 
                          WHERE nft_balances.contract = $/contract/
                            ${
                              collection.tokenIdRange.length
                                ? "AND nft_balances.token_id <@ $/tokenIdRange:raw/"
                                : ""
                            }
                            AND nft_balances.amount > 0;

                  `;
        } else {
          ownerCountQuery = `
                      SELECT 
                            COUNT(
                              DISTINCT(owner)
                            ) AS "ownerCount" 
                          FROM nft_balances
                            JOIN tokens ON tokens.contract = nft_balances.contract 
                            AND tokens.token_id = nft_balances.token_id 
                          WHERE tokens.collection_id = $/collectionId/
                            AND nft_balances.amount > 0;
                  `;
        }

        const { ownerCount } = await ridb.oneOrNone(ownerCountQuery, {
          collectionId: collection.id,
          contract: toBuffer(collection.contract),
          tokenIdRange: !_.isEmpty(collection.tokenIdRange)
            ? `numrange(${collection.tokenIdRange[0]}, ${collection.tokenIdRange[1]}, '[]')`
            : undefined,
        });

        if (Number(ownerCount) !== collection.ownerCount) {
          await idb.none(
            `
              UPDATE collections
                SET 
                  owner_count = $/ownerCount/, 
                  updated_at = now() 
                WHERE id = $/collectionId/
                AND (owner_count IS DISTINCT FROM $/ownerCount/);
              `,
            {
              collectionId: collection.id,
              ownerCount,
            }
          );
        }
      } else {
        const acquiredScheduleLock = await acquireLock(
          this.getScheduleLockName(collection.id),
          60 * 5
        );

        if (acquiredScheduleLock) {
          const delay = await getLockExpiration(this.getCalcLockName(collection.id));

          await this.addToQueue(
            [
              {
                context: this.queueName,
                kind: "collectionId",
                data: {
                  collectionId: collection.id,
                },
              },
            ],
            delay
          );
        }
      }
    }
  }

  getCalcLockName = (collectionId: string) => {
    return `${this.queueName}-calc-lock:${collectionId}`;
  };

  getScheduleLockName = (collectionId: string) => {
    return `${this.queueName}-schedule-lock:${collectionId}`;
  };

  public async addToQueue(infos: RecalcOwnerCountQueueJobPayload[], delayInSeconds = 0) {
    await this.sendBatch(
      infos.map((info) => ({
        payload: info,
        delay: delayInSeconds * 1000,
        jobId:
          info.kind === "collectionId"
            ? info.data.collectionId
            : `${info.data.contract}:${info.data.tokenId}`,
      }))
    );
  }
}

export const recalcOwnerCountQueueJob = new RecalcOwnerCountQueueJob();
