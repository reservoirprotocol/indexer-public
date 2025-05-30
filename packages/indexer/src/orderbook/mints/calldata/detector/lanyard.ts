import axios from "axios";

import { redis } from "@/common/redis";
import {
  CollectionMint,
  getCollectionMints,
  simulateAndUpsertCollectionMints,
} from "@/orderbook/mints";
import { MethodSignature } from "@/orderbook/mints/method-signatures";

// Unused at the moment

const STANDARD = "lanyard";

export const extractByCollectionMint = async (
  collectionMint: CollectionMint,
  methodSignature: MethodSignature
): Promise<CollectionMint[]> => {
  const results: CollectionMint[] = [];

  try {
    const proofParamIndex = methodSignature.params
      .split(",")
      .findIndex((abiType) => abiType === "bytes32[]");
    if (proofParamIndex === -1) {
      return [];
    }

    const proofValue = methodSignature.decodedCalldata[proofParamIndex];
    const { data } = await axios.get(`https://lanyard.org/api/v1/roots`, {
      params: {
        proof: proofValue.join(","),
      },
    });

    if (data.error) {
      return [];
    }

    if (data.roots.length > 1) {
      return [];
    }

    const merkleRoot = data.roots[0];

    collectionMint.details.tx.data.params[proofParamIndex] = {
      kind: "allowlist",
      abiType: "bytes32[]",
    };

    collectionMint.standard = STANDARD;
    collectionMint.allowlistId = merkleRoot;
    collectionMint.stage = "lanyard-claim";
    collectionMint.kind = "allowlist";

    // results.push(collectionMint);
  } catch {
    // Skip errors
  }

  return results;
};

export const refreshByCollection = async (collection: string) => {
  const existingCollectionMints = await getCollectionMints(collection, { standard: STANDARD });

  // TODO: We should look into re-detecting and updating any fields that
  // could have changed on the mint since the initial detection
  await simulateAndUpsertCollectionMints(existingCollectionMints);
};

type ProofValue = string[];

export const generateProofValue = async (
  collectionMint: CollectionMint,
  address: string
): Promise<ProofValue> => {
  const cacheKey = `${collectionMint.collection}-${collectionMint.stage}-${collectionMint.tokenId}-${address}`;
  let result: ProofValue = await redis
    .get(cacheKey)
    .then((response) => (response ? JSON.parse(response) : undefined));
  if (!result) {
    result = await axios
      .get(
        `https://lanyard.org/api/v1/proof?unhashedLeaf=${address}&root=${collectionMint.allowlistId}`
      )
      .then(({ data }) => data.proof);

    if (result) {
      await redis.set(cacheKey, JSON.stringify(result), "EX", 3600);
    }
  }

  return result;
};
