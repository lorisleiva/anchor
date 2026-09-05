import { Buffer } from "buffer";
import {
  Address,
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  KeyPairSigner,
  ReadonlyUint8Array,
  TransactionPartialSigner,
} from "@solana/kit";
import { isBrowser } from "./utils/common.js";

/**
 * Creates a {@link TransactionSigner} from a 64-byte ed25519 secret key: a
 * 32-byte private key seed followed by the 32-byte public key, as stored in
 * Solana keypair files and in web3.js `Keypair.secretKey`.
 *
 * Unlike Kit's `createKeyPairSignerFromBytes`, this returns synchronously:
 * the address is derived directly from the public key half of the secret
 * key, and the WebCrypto key import is deferred until the first signature
 * is requested. This keeps synchronous wallet construction possible, which
 * `AnchorProvider.local()`/`env()` and the `getProvider()` fallback rely on
 * (e.g. `setProvider(AnchorProvider.env())` at the top of CommonJS test
 * files, where no top-level await is available).
 */
export function createWallet(
  secretKey: ReadonlyUint8Array
): TransactionPartialSigner {
  if (secretKey.length !== 64) {
    throw new Error(
      `Expected a 64-byte secret key, got ${secretKey.length} bytes`
    );
  }
  const bytes = Uint8Array.from(secretKey);
  const address = getBase58Decoder().decode(bytes.slice(32)) as Address;

  let keyPairSigner: Promise<KeyPairSigner> | undefined;
  const signer: TransactionPartialSigner = {
    address,
    async signTransactions(transactions, config) {
      keyPairSigner ??= createKeyPairSignerFromBytes(bytes);
      return await (await keyPairSigner).signTransactions(transactions, config);
    },
  };

  return signer;
}

/**
 * Creates a {@link TransactionSigner} from the keypair file at the path in
 * the `ANCHOR_WALLET` environment variable.
 *
 * (This API is for Node only.)
 */
export function createLocalWallet(): TransactionPartialSigner {
  if (isBrowser) {
    throw new Error("Local wallet is not available in the browser.");
  }

  const process = require("process");
  if (!process.env.ANCHOR_WALLET || process.env.ANCHOR_WALLET === "") {
    throw new Error(
      "expected environment variable `ANCHOR_WALLET` is not set."
    );
  }

  return createWallet(
    Buffer.from(
      JSON.parse(
        require("fs").readFileSync(process.env.ANCHOR_WALLET, {
          encoding: "utf-8",
        })
      )
    )
  );
}
