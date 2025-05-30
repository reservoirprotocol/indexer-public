import pLimit from "p-limit";

import { AbstractRabbitMqJobHandler, BackoffStrategy } from "@/jobs/abstract-rabbit-mq-job-handler";
import { idb, pgp, PgPromiseQuery } from "@/common/db";
import { acquireLock } from "@/common/redis";
import { toBuffer } from "@/common/utils";
import * as es from "@/events-sync/storage";
import { assignRoyaltiesToFillEvents } from "@/events-sync/handlers/royalties";
import { assignWashTradingScoreToFillEvents } from "@/events-sync/handlers/utils/fills";
import _ from "lodash";
import { logger } from "@/common/logger";

export type FillPostProcessJobPayload = {
  fillEvents: es.fills.Event[];
  attempt: number;
};

export class FillPostProcessJob extends AbstractRabbitMqJobHandler {
  queueName = "fill-post-process-v2";
  maxRetries = 5;
  concurrency = 1;
  timeout = 60000;
  singleActiveConsumer = true;
  backoff = {
    type: "exponential",
    delay: 1000,
  } as BackoffStrategy;

  public async process(payload: FillPostProcessJobPayload) {
    const minValidPrice = 10; // Minimum amount of sale to be considered valid, any sale under is automatically considered wash trading
    const maxAttempts = 20;
    const { fillEvents, attempt } = payload;

    const promiseAllResults = await Promise.all([
      assignRoyaltiesToFillEvents(fillEvents),
      assignWashTradingScoreToFillEvents(fillEvents),
    ]);

    if (!_.isEmpty(promiseAllResults[0])) {
      if (maxAttempts <= attempt) {
        logger.info(
          this.queueName,
          `max attempts for fill events ${JSON.stringify(promiseAllResults[0])}`
        );
      } else {
        await this.addToQueue([promiseAllResults[0]], attempt + 1, 15 * 1000);
      }
    }

    const freeFillEvents: es.fills.Event[] = [];
    const limit = pLimit(10);

    await Promise.all(
      fillEvents.map((fillEvent: es.fills.Event) =>
        limit(async () => {
          const baseEventParams = fillEvent.baseEventParams;
          const lockId = `fill-event-${baseEventParams.txHash}-${baseEventParams.logIndex}-${baseEventParams.batchIndex}`;
          try {
            if (await acquireLock(lockId, 10)) {
              freeFillEvents.push(fillEvent);
            }
          } catch {
            // Skip errors
          }
        })
      )
    );

    const queries: PgPromiseQuery[] = freeFillEvents.map((event) => {
      return {
        query: `
            UPDATE fill_events_2 SET
              wash_trading_score = $/washTradingScore/,
              royalty_fee_bps = $/royaltyFeeBps/,
              marketplace_fee_bps = $/marketplaceFeeBps/,
              royalty_fee_breakdown = $/royaltyFeeBreakdown:json/,
              marketplace_fee_breakdown = $/marketplaceFeeBreakdown:json/,
              paid_full_royalty = $/paidFullRoyalty/,
              net_amount = $/netAmount/,
              updated_at = now()
            WHERE tx_hash = $/txHash/
              AND log_index = $/logIndex/
              AND batch_index = $/batchIndex/
              AND (wash_trading_score IS DISTINCT FROM $/washTradingScore/
                   OR royalty_fee_bps IS DISTINCT FROM $/royaltyFeeBps/
                   OR marketplace_fee_bps IS DISTINCT FROM $/marketplaceFeeBps/
                   OR royalty_fee_breakdown IS DISTINCT FROM $/royaltyFeeBreakdown:json/
                   OR marketplace_fee_breakdown IS DISTINCT FROM $/marketplaceFeeBreakdown:json/
                   OR paid_full_royalty IS DISTINCT FROM $/paidFullRoyalty/
                   OR net_amount IS DISTINCT FROM $/netAmount/)
          `,
        values: {
          washTradingScore: Number(event.price) <= minValidPrice ? 1 : event.washTradingScore || 0,
          royaltyFeeBps: event.royaltyFeeBps || undefined,
          marketplaceFeeBps: event.marketplaceFeeBps || undefined,
          royaltyFeeBreakdown: event.royaltyFeeBreakdown || undefined,
          marketplaceFeeBreakdown: event.marketplaceFeeBreakdown || undefined,
          paidFullRoyalty: event.paidFullRoyalty ?? undefined,
          netAmount: event.netAmount || undefined,
          txHash: toBuffer(event.baseEventParams.txHash),
          logIndex: event.baseEventParams.logIndex,
          batchIndex: event.baseEventParams.batchIndex,
        },
      };
    });

    if (queries.length) {
      await idb.none(pgp.helpers.concat(queries));
    }
  }

  public async addToQueue(fillInfos: es.fills.Event[][], attempt = 0, delay = 0) {
    await this.sendBatch(
      fillInfos.map((info) => ({ payload: { fillEvents: info, attempt }, delay }))
    );
  }
}

export const fillPostProcessJob = new FillPostProcessJob();
