import { AbstractRabbitMqJobHandler, BackoffStrategy } from "@/jobs/abstract-rabbit-mq-job-handler";
import { unsyncEvents } from "@/events-sync/index";
import { logger } from "@/common/logger";
import { eventsSyncBackfillJob } from "@/jobs/events-sync/events-sync-backfill-job";
import * as blocksModel from "@/models/blocks";
import { idb } from "@/common/db";
import { baseProvider } from "@/common/provider";
import { fromBuffer } from "@/common/utils";
import { HashZero } from "@ethersproject/constants";
import { config } from "@/config/index";

export type BlockCheckJobPayload = {
  block: number;
  blockHash?: string;
};

export default class BlockCheckJob extends AbstractRabbitMqJobHandler {
  queueName = "events-sync-block-check";
  maxRetries = 10;
  concurrency = [204].includes(config.chainId) ? 5 : 1;
  timeout = 60000;
  backoff = {
    type: "exponential",
    delay: 30000,
  } as BackoffStrategy;
  enableFailedJobsRetry = true;

  public async process(payload: BlockCheckJobPayload) {
    const { block, blockHash } = payload;

    try {
      // Generic method for handling an orphan block
      const handleOrphanBlock = async (block: { number: number; hash: string }) => {
        // Resync the detected orphaned block
        await eventsSyncBackfillJob.addToQueue(block.number, block.number, {});
        await unsyncEvents(block.number, block.hash);

        // Delete the orphaned block from the `blocks` table
        await blocksModel.deleteBlock(block.number, block.hash);

        // TODO: Also delete transactions associated to the orphaned
        // block and fetch the transactions of the replacement block
      };

      // Fetch the latest upstream hash for the specified block
      const upstreamBlockHash = (await baseProvider.getBlock(Number(block))).hash.toLowerCase();

      // When `blockHash` is empty, force recheck all event tables
      if (!blockHash) {
        const result = await idb.manyOrNone(
          `
              (SELECT
                nft_transfer_events.block_hash
              FROM nft_transfer_events
              WHERE nft_transfer_events.block = $/block/ AND nft_transfer_events.is_deleted = 0)

              UNION

              (SELECT
                ft_transfer_events.block_hash
              FROM ft_transfer_events
              WHERE ft_transfer_events.block = $/block/)

              UNION

              (SELECT
                nft_approval_events.block_hash
              FROM nft_approval_events
              WHERE nft_approval_events.block = $/block/)

              UNION

              (SELECT
                fill_events_2.block_hash
              FROM fill_events_2
              WHERE fill_events_2.block = $/block/ AND fill_events_2.is_deleted = 0)

              UNION

              (SELECT
                cancel_events.block_hash
              FROM cancel_events
              WHERE cancel_events.block = $/block/)

              UNION

              (SELECT
                bulk_cancel_events.block_hash
              FROM bulk_cancel_events
              WHERE bulk_cancel_events.block = $/block/)
            `,
          { block }
        );

        for (const { block_hash } of result) {
          const blockHash = fromBuffer(block_hash);
          if (blockHash.toLowerCase() !== upstreamBlockHash.toLowerCase()) {
            logger.info(
              this.queueName,
              `Detected orphan block ${block} with hash ${blockHash}}, upstream hash: ${upstreamBlockHash}`
            );
            await handleOrphanBlock({ number: block, hash: blockHash });
          }
        }
      } else {
        if (upstreamBlockHash.toLowerCase() !== blockHash.toLowerCase()) {
          logger.info(
            this.queueName,
            `Detected orphan block ${block} with hash ${blockHash}}, upstream hash: ${upstreamBlockHash}`
          );
          await handleOrphanBlock({ number: block, hash: blockHash });
        }
      }
    } catch (error) {
      logger.error(
        this.queueName,
        JSON.stringify({
          message: `Failed to process block ${block} with hash ${blockHash}. error=${error}`,
          payload,
          error,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          stack: (error as any).stack,
        })
      );

      throw error;
    }
  }

  public async addToQueue(block: BlockCheckJobPayload, delay = 0) {
    await this.send(
      {
        payload: block,
        jobId: `${block.block}-${block.blockHash ?? HashZero}-${delay}`,
      },
      Number(delay) * 1000
    );
  }

  public async addBulk(blocks: BlockCheckJobPayload[], delay = 0) {
    await this.sendBatch(
      blocks.map((block) => ({
        payload: { block: block.block, blockHash: block.blockHash },
        jobId: delay ? `${block.block}-${block.blockHash ?? HashZero}-${delay}` : undefined,
        delay: Number(delay) * 1000,
      }))
    );
  }
}

export const blockCheckJob = new BlockCheckJob();
