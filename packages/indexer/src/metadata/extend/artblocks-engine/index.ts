/* eslint-disable @typescript-eslint/no-explicit-any */

import { config } from "@/config/index";
import { CollectionMetadata, TokenMetadata } from "@/metadata/types";
import axios from "axios";
import slugify from "slugify";
import { logger } from "@/common/logger";

// This param indicate this is a shared contract logic that handles multiple collections sharing the same contract
export const isSharedContract = true;

export const extendCollection = async (metadata: CollectionMetadata, _tokenId = null) => {
  if (isNaN(Number(_tokenId)) || !_tokenId) {
    throw new Error(`Invalid tokenId ${_tokenId}`);
  }

  const startTokenId = _tokenId - (_tokenId % 1000000);
  const endTokenId = startTokenId + 1000000 - 1;

  let baseUrl = "https://token.artblocks.io";

  if (config.chainId === 42161) {
    baseUrl = "https://token.arbitrum.artblocks.io";
  } else if ([4, 5].includes(config.chainId)) {
    baseUrl = "https://token.staging.artblocks.io";
  } else if ([11155111].includes(config.chainId)) {
    // baseUrl = "https://token.sepolia.artblocks.io";
    baseUrl = "https://uid16ni343.execute-api.us-east-1.amazonaws.com/Prod";
  } else if ([8453].includes(config.chainId)) {
    baseUrl = "https://token.base.artblocks.io";
  }

  const url = `${baseUrl}/${metadata.contract}/${_tokenId}`;
  const { data } = await axios.get(url);

  return {
    ...metadata,
    metadata: {
      ...metadata.metadata,
      imageUrl: data.image,
      description: data.description,
      externalUrl: data.website,
    },
    name: data.collection_name,
    slug: metadata.isFallback ? slugify(data.collection_name, { lower: true }) : metadata.slug,
    community: data.platform.toLowerCase(),
    id: `${metadata.contract}:${startTokenId}:${endTokenId}`.toLowerCase(),
    tokenIdRange: [startTokenId, endTokenId],
    tokenSetId: `range:${metadata.contract}:${startTokenId}:${endTokenId}`,
    isFallback: undefined,
  };
};

export const extend = async (metadata: TokenMetadata) => {
  const startTokenId = metadata.tokenId - (metadata.tokenId % 1000000);
  const endTokenId = startTokenId + 1000000 - 1;

  try {
    let baseUrl = "https://token.artblocks.io";
    if (config.chainId === 42161) {
      baseUrl = "https://token.arbitrum.artblocks.io";
    } else if ([4, 5].includes(config.chainId)) {
      baseUrl = "https://token.staging.artblocks.io";
    } else if ([11155111].includes(config.chainId)) {
      // baseUrl = "https://token.sepolia.artblocks.io";
      baseUrl = "https://uid16ni343.execute-api.us-east-1.amazonaws.com/Prod";
    }

    const url = `${baseUrl}/${metadata.contract}/${metadata.tokenId}`;
    const { data } = await axios.get(url);

    const imageUrl = metadata.imageUrl ?? data.image;
    const mediaUrl = metadata.mediaUrl ?? data.animation_url ?? data.generator_url;

    const attributes = [];

    if (data.features) {
      // Add None value for core traits
      for (const [key, value] of Object.entries(data.features)) {
        attributes.push({
          key,
          rank: 1,
          value,
          kind: "string",
        });
      }
    }

    return {
      ...metadata,
      attributes,
      imageUrl,
      mediaUrl,
      collection: `${metadata.contract}:${startTokenId}:${endTokenId}`.toLowerCase(),
    };
  } catch (error) {
    logger.warn(
      "artblocks-engine-fetcher",
      JSON.stringify({
        message: `fetchToken get json error. error:${error}`,
        contract: metadata.contract,
        tokenId: metadata.tokenId,
        error,
      })
    );
  }

  return {
    ...metadata,
    collection: `${metadata.contract}:${startTokenId}:${endTokenId}`.toLowerCase(),
  };
};
