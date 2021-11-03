import { getRealURL } from "../utils/url";
import { ArConnectEvent } from "../views/Popup/routes/Settings";
import { connect, disconnect } from "../background/api/connection";
import {
  activeAddress,
  allAddresses,
  publicKey
} from "../background/api/address";
import { addToken, walletNames } from "../background/api/utility";
import { signTransaction } from "../background/api/transaction";
import {
  MessageFormat,
  MessageType,
  validateMessage
} from "../utils/messenger";
import {
  checkPermissions,
  getActiveTab,
  getArweaveConfig,
  getPermissions,
  getStoreData,
  walletsStored,
  checkCommunityContract
} from "../utils/background";
import { decrypt, encrypt, signature } from "../background/api/encryption";
import {
  handleTabUpdate,
  handleArweaveTabOpened,
  handleArweaveTabClosed,
  handleArweaveTabActivated,
  handleBrowserLostFocus,
  handleBrowserGainedFocus,
  getArweaveActiveTab
} from "../background/tab_update";
import { browser, Runtime } from "webextension-polyfill-ts";
import { fixupPasswords } from "../utils/auth";
import { SignatureOptions } from "arweave/web/lib/crypto/crypto-interface";
import { Chunk } from "../utils/chunks";
import Transaction, { Tag } from "arweave/web/lib/transaction";

// stored transactions and their chunks
let transactions: {
  chunkCollectionID: string; // unique ID for this collection
  transaction: Transaction;
  signatureOptions: SignatureOptions;
  origin: string; // tabID for verification
  rawChunks: Chunk[]; // raw chunks to be reconstructed
}[] = [];

// open the welcome page
browser.runtime.onInstalled.addListener(async () => {
  if (!(await walletsStored()))
    browser.tabs.create({ url: browser.runtime.getURL("/welcome.html") });
  else await fixupPasswords();
});

browser.windows.onFocusChanged.addListener(async (windowId) => {
  if (!(await walletsStored())) return;

  if (windowId === browser.windows.WINDOW_ID_NONE) {
    handleBrowserLostFocus();
  } else {
    const activeTab = await getActiveTab();
    const txId = await checkCommunityContract(activeTab.url!);
    if (txId) handleBrowserGainedFocus(activeTab.id!, txId);
  }
});

// Create listeners for the icon utilities and context menu item updates.
browser.tabs.onActivated.addListener(async (activeInfo) => {
  if (!(await walletsStored())) return;

  handleArweaveTabActivated(activeInfo.tabId);

  handleTabUpdate();
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!(await walletsStored())) return;

  if (changeInfo.status === "complete") {
    const txId = await checkCommunityContract(tab.url!);
    if (txId) {
      handleArweaveTabOpened(tabId, txId);
    } else {
      if (tabId === (await getArweaveActiveTab())) {
        // It looks like user just entered or opened another web site on the same tab,
        // where Arweave resource was loaded previously. Hence it needs to be closed.
        handleArweaveTabClosed(tabId);
      }
    }
  }

  handleTabUpdate();
});

browser.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  if (!(await walletsStored())) return;

  const activeTab = await getActiveTab();
  if (await checkCommunityContract(activeTab.url!))
    handleArweaveTabClosed(tabId);
});

browser.runtime.onConnect.addListener((connection) => {
  if (connection.name !== "backgroundConnection") return;
  connection.onMessage.addListener(async (msg, port) => {
    if (!validateMessage(msg, { sender: "api" })) return;
    const res = await handleApiCalls(msg, port);
    connection.postMessage({ ...res, ext: "arconnect" });
  });
});

// listen for messages from the content script
const handleApiCalls = async (
  message: MessageFormat,
  port: Runtime.Port
): Promise<MessageFormat> => {
  try {
    const eventsStore = localStorage.getItem("arweave_events"),
      events: ArConnectEvent[] = eventsStore
        ? JSON.parse(eventsStore)?.val
        : [],
      activeTab = await getActiveTab(),
      tabURL = activeTab.url as string,
      faviconUrl = activeTab.favIconUrl,
      blockedSites = (await getStoreData())?.["blockedSites"];

    // check if site is blocked
    if (blockedSites) {
      if (
        blockedSites.includes(getRealURL(tabURL)) ||
        blockedSites.includes(tabURL)
      )
        return {
          type: `${message.type}_result` as MessageType,
          ext: "arconnect",
          res: false,
          message: "Site is blocked",
          sender: "background"
        };
    }

    // if no wallets are stored, return and open the login page
    if (!(await walletsStored())) {
      browser.tabs.create({ url: browser.runtime.getURL("/welcome.html") });
      return {
        type: "connect_result",
        ext: "arconnect",
        res: false,
        message: "No wallets added",
        sender: "background"
      };
    }

    // update events
    localStorage.setItem(
      "arweave_events",
      JSON.stringify({
        val: [
          // max 100 events
          ...events.filter((_, i) => i < 98),
          { event: message.type, url: tabURL, date: Date.now() }
        ]
      })
    );

    switch (message.type) {
      // connect to arconnect
      case "connect":
        return {
          type: "connect_result",
          ext: "arconnect",
          sender: "background",
          ...(await connect(message, tabURL, faviconUrl))
        };

      // disconnect from arconnect
      case "disconnect":
        return {
          type: "disconnect_result",
          ext: "arconnect",
          sender: "background",
          ...(await disconnect(tabURL))
        };

      // get the active/selected address
      case "get_active_address":
        if (!(await checkPermissions(["ACCESS_ADDRESS"], tabURL)))
          return {
            type: "get_active_address_result",
            ext: "arconnect",
            res: false,
            message:
              "The site does not have the required permissions for this action",
            sender: "background"
          };

        return {
          type: "get_active_address_result",
          ext: "arconnect",
          sender: "background",
          ...(await activeAddress())
        };

      // get the public key of the active/selected address
      case "get_active_public_key":
        if (!(await checkPermissions(["ACCESS_PUBLIC_KEY"], tabURL)))
          return {
            type: "get_active_public_key_result",
            ext: "arconnect",
            res: false,
            message:
              "The site does not have the required permissions for this action",
            sender: "background"
          };

        return {
          type: "get_active_public_key_result",
          ext: "arconnect",
          sender: "background",
          ...(await publicKey())
        };

      // get all addresses added to ArConnect
      case "get_all_addresses":
        if (!(await checkPermissions(["ACCESS_ALL_ADDRESSES"], tabURL)))
          return {
            type: "get_all_addresses_result",
            ext: "arconnect",
            res: false,
            message:
              "The site does not have the required permissions for this action",
            sender: "background"
          };

        return {
          type: "get_all_addresses_result",
          ext: "arconnect",
          sender: "background",
          ...(await allAddresses())
        };

      // get names of wallets added to ArConnect
      case "get_wallet_names":
        if (!(await checkPermissions(["ACCESS_ALL_ADDRESSES"], tabURL)))
          return {
            type: "get_wallet_names_result",
            ext: "arconnect",
            res: false,
            message:
              "The site does not have the required permissions for this action",
            sender: "background"
          };

        return {
          type: "get_wallet_names_result",
          ext: "arconnect",
          sender: "background",
          ...(await walletNames())
        };

      // return permissions for the current url
      case "get_permissions":
        return {
          type: "get_permissions_result",
          ext: "arconnect",
          res: true,
          permissions: await getPermissions(tabURL),
          sender: "background"
        };

      // get the user's custom arweave config
      case "get_arweave_config":
        if (!(await checkPermissions(["ACCESS_ARWEAVE_CONFIG"], tabURL)))
          return {
            type: "get_arweave_config_result",
            ext: "arconnect",
            res: false,
            message:
              "The site does not have the required permissions for this action",
            sender: "background"
          };

        return {
          type: "get_arweave_config_result",
          ext: "arconnect",
          res: true,
          config: await getArweaveConfig(),
          sender: "background"
        };

      // add a custom token
      case "add_token":
        return {
          type: "add_token_result",
          ext: "arconnect",
          sender: "background",
          ...(await addToken(message))
        };

      // sign a transaction
      case "sign_transaction":
        if (!(await checkPermissions(["SIGN_TRANSACTION"], tabURL)))
          return {
            type: "sign_transaction_result",
            ext: "arconnect",
            res: false,
            message:
              "The site does not have the required permissions for this action",
            sender: "background"
          };

        // Begin listening for chunks
        // this initializes a new array element
        // with all the data for a future signing
        // the content of the chunks will get pushed
        // here
        transactions.push({
          chunkCollectionID: message.chunkCollectionID,
          transaction: {
            ...message.transaction,
            // add an empty tag array and data array to start,
            data: new Uint8Array(),
            tags: []
          },
          signatureOptions: message.signatureOptions,
          // @ts-ignore
          origin: port.sender.origin,
          rawChunks: []
        });

        // tell the injected script that the background
        // script is ready to receive the chunks
        return {
          type: "sign_transaction_result",
          ext: "arconnect",
          sender: "background",
          res: true
        };

      // receive and reconstruct a chunk
      case "sign_transaction_chunk":
        // get the chunk from the message
        const chunk: Chunk = message.chunk;
        // find the key of the transaction that the
        // chunk belongs to
        // also check if the origin of the chunk matches
        // the origin of the tx creation
        const txArrayID = transactions.findIndex(
          ({ chunkCollectionID, origin }) =>
            chunkCollectionID === chunk.collectionID &&
            // @ts-expect-error
            origin === port.sender.origin
        );

        // throw error if the owner tx of this chunk is not present
        if (txArrayID < 0)
          return {
            type: "sign_transaction_chunk_result",
            ext: "arconnect",
            res: false,
            message: "Invalid origin for chunk",
            sender: "background"
          };

        // push valid chunk for evaluation in the future
        transactions[txArrayID].rawChunks.push(chunk);

        // let the injected script know that it can send the next chunk
        return {
          type: "sign_transaction_chunk_result",
          ext: "arconnect",
          res: true,
          sender: "background"
        };

      case "sign_transaction_end":
        // find the the transaction whose chunk
        // stream is ending
        // also check if the origin matches
        // the origin of the tx creation
        const reconstructTx = transactions.find(
          ({ chunkCollectionID, origin }) =>
            chunkCollectionID === message.chunkCollectionID &&
            // @ts-expect-error
            origin === port.sender.origin
        );

        // throw error if the owner tx of this tx is not present
        if (!reconstructTx)
          return {
            type: "sign_transaction_end_result",
            ext: "arconnect",
            res: false,
            message: "Invalid origin for end request",
            sender: "background"
          };

        // sort the chunks by their indexes to make sure
        // that we are not loading them in the wrong order
        reconstructTx.rawChunks.sort((a, b) => a.index - b.index);

        // create a Uint8Array to reconstruct the data to
        const reconstructedData = new Uint8Array(
          parseFloat(reconstructTx.transaction.data_size ?? "0")
        );
        let previousLength = 0;

        // loop through the raw chunks and reconstruct
        // the transaction fields: data and tags
        for (const chunk of reconstructTx.rawChunks) {
          if (chunk.type === "data") {
            // handle data chunks
            // create a Uint8Array from the chunk value
            const chunkBuffer = new Uint8Array(chunk.value as Uint8Array);

            // append the value of the chunk after the
            // previous array (using the currently filled
            // indexes with "previousLength")
            reconstructedData.set(chunkBuffer, previousLength);
            previousLength += chunkBuffer.length; // increase the previous length by the buffer size
          } else if (chunk.type === "tag") {
            // handle tag chunks by simply pushing them
            reconstructTx.transaction.tags.push(chunk.value as Tag);
          }
        }

        // update the tx data with the reconstructed data
        reconstructTx.transaction.data = reconstructedData;

        // clean up the raw chunks
        reconstructTx.rawChunks = [];

        const signResult = await signTransaction(
          reconstructTx.transaction,
          tabURL,
          message.signatureOptions
        );

        // now the tx is ready for signing, the injected
        // script can request the background script to sign
        return {
          type: "sign_transaction_end_result",
          ext: "arconnect",
          sender: "background",
          chunkCollectionID: message.chunkCollectionID,
          ...signResult
        };

      case "encrypt":
        if (!(await checkPermissions(["ENCRYPT"], tabURL)))
          return {
            type: "encrypt_result",
            ext: "arconnect",
            res: false,
            message:
              "The site does not have the required permissions for this action",
            sender: "background"
          };

        return {
          type: "encrypt_result",
          ext: "arconnect",
          sender: "background",
          ...(await encrypt(message, tabURL))
        };

      case "decrypt":
        if (!(await checkPermissions(["DECRYPT"], tabURL)))
          return {
            type: "decrypt_result",
            ext: "arconnect",
            res: false,
            message:
              "The site does not have the required permissions for this action",
            sender: "background"
          };

        return {
          type: "decrypt_result",
          ext: "arconnect",
          sender: "background",
          ...(await decrypt(message, tabURL))
        };

      case "signature":
        if (!(await checkPermissions(["SIGNATURE"], tabURL)))
          return {
            type: "signature_result",
            ext: "arconnect",
            res: false,
            message:
              "The site does not have the required permissions for this action",
            sender: "background"
          };

        return {
          type: "signature_result",
          ext: "arconnect",
          sender: "background",
          ...(await signature(message, tabURL))
        };

      default:
        break;
    }

    return {
      type: `${message.type}_result` as MessageType,
      ext: "arconnect",
      res: false,
      message: "Unknown error",
      sender: "background"
    };
  } catch (e) {
    return {
      type: `${message.type}_result` as MessageType,
      ext: "arconnect",
      res: false,
      message: `Internal error: \n${e}`,
      sender: "background"
    };
  }
};

// listen for messages from the popup
// right now the only message from there
// is for the wallet switch event
browser.runtime.onMessage.addListener(async (message: MessageFormat) => {
  const activeTab = await getActiveTab();

  if (!validateMessage(message, { sender: "popup" })) return;
  if (!(await walletsStored())) return;

  switch (message.type) {
    case "archive_page":
      const response: MessageFormat = await browser.tabs.sendMessage(
        activeTab.id as number,
        message
      );
      return { ...response, url: activeTab.url };

    case "switch_wallet_event":
      if (
        !(await checkPermissions(
          ["ACCESS_ALL_ADDRESSES", "ACCESS_ADDRESS"],
          activeTab.url as string
        ))
      )
        return;

      browser.tabs.sendMessage(activeTab.id as number, {
        ...message,
        type: "switch_wallet_event_forward"
      });

      break;
  }
});

export {};
