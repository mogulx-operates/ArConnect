import { ModuleFunction } from "../../background";
import { SignatureOptions } from "arweave/web/lib/crypto/crypto-interface";
import { calculateReward, constructTransaction } from "./transaction_builder";
import { getArweaveConfig } from "../../../utils/background";
import { cleanUpChunks, getChunks } from "./chunks";
import { allowanceAuth } from "./allowance";
import Transaction from "arweave/web/lib/transaction";
import Arweave from "arweave";

const background: ModuleFunction<void> = async (
  _,
  tx: Transaction,
  options: SignatureOptions,
  chunkCollectionID: string
) => {
  // get chunks for transaction
  const chunks = getChunks(chunkCollectionID);

  // reconstruct the transaction from the chunks
  const transaction = constructTransaction(tx, chunks || []);

  // clean up chunks
  cleanUpChunks(chunkCollectionID);

  // append fee multiplier to the transaction
  transaction.reward = await calculateReward(transaction);

  // validate the user's allowance for this app
  // if it is not enough, we need the user to
  // raise it or cancel the transaction
  const price = +transaction.reward + parseInt(transaction.quantity);

  await allowanceAuth(price);

  // add ArConnect tags to the transaction

  // sign the transaction

  // schedule fee transaction for later execution
  // this is needed for a faster transaction signing

  // update allowance spent amount (in winstons)

  // de-construct the transaction:
  // remove "tags" and "data", so we don't have to
  // send those back in chunks
  // instead we can re-construct the transaction again
  // in the foreground function, which improves speed

  // return de-constructed transaction
};

export default background;
