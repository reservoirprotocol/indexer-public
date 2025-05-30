/* eslint-disable @typescript-eslint/no-explicit-any */

import axios from "axios";
import { config } from "@/config/index";
import { handleTokenUriErrorResponse, handleTokenUriResponse } from "@/metadata/providers/utils";

export const fetchTokenUriMetadata = async (
  { contract, tokenId }: { contract: string; tokenId: string },
  uri: string
) => {
  return axios
    .get(uri, {
      headers: {
        "Content-Type": "application/json",
        "User-Agent": config.yugalabsMetadataApiUserAgent,
      },
    })
    .then((res) => handleTokenUriResponse(contract, tokenId, res))
    .catch((error) => handleTokenUriErrorResponse(contract, tokenId, error));
};
