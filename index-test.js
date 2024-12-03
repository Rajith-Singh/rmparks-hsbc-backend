const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const openpgp = require('openpgp');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const port = 3001;

// Load PGP keys from specified file paths
async function loadPGPKey(filePath) {
    try {
        const key = await fs.readFile(filePath, 'utf8');
        if (!key.includes('BEGIN PGP')) {
            throw new Error('Invalid PGP key format');
        }
        console.log(`Successfully loaded key from: ${filePath}`);
        return key.toString();
    } catch (error) {
        console.error(`Error loading PGP key from ${filePath}:`, error.message);
        throw error;
    }
}

// Sign and encrypt the payload with OpenPGP
async function signAndEncryptData(data, clientPrivateKeyArmored, hsbcPublicKeyArmored, passphrase) {
    try {
        console.log("Signing and encrypting the request...");
        const privateKey = await openpgp.decryptKey({
            privateKey: await openpgp.readPrivateKey({ armoredKey: clientPrivateKeyArmored }),
            passphrase,
        });
        const publicKey = await openpgp.readKey({ armoredKey: hsbcPublicKeyArmored });

        const message = await openpgp.createMessage({ text: data });
        const encrypted = await openpgp.encrypt({
            message,
            encryptionKeys: publicKey,
            signingKeys: privateKey,
        });

        console.log("Successfully signed and encrypted the data.");
        return Buffer.from(encrypted).toString('base64');
    } catch (error) {
        console.error("Error signing and encrypting data:", error.message);
        throw error;
    }
}

// Decrypt and verify the response from HSBC
async function decryptAndVerifyResponse(reportBase64, clientPrivateKeyArmored, hsbcPublicKeyArmored, passphrase) {
    try {
        console.log("Starting decryption and verification...");

        const privateKey = await openpgp.decryptKey({
            privateKey: await openpgp.readPrivateKey({ armoredKey: clientPrivateKeyArmored }),
            passphrase,
        });
        const publicKey = await openpgp.readKey({ armoredKey: hsbcPublicKeyArmored });

        const message = await openpgp.readMessage({
            armoredMessage: Buffer.from(reportBase64, 'base64').toString('utf8'),
        });

        const { data: decryptedData, verified } = await openpgp.decrypt({
            message,
            decryptionKeys: privateKey,
            verificationKeys: publicKey,
        });

        await verified;
        console.log("Signature verified successfully.");

        const reportData = JSON.parse(decryptedData);
        console.log("Decoded Report Data (Parsed JSON):", reportData);

        return reportData.transactions || {};
    } catch (error) {
        console.error("Error decrypting and verifying response:", error.message);

        if (error.message.includes("Session key decryption failed")) {
            console.error(
                "Potential Causes:\n" +
                "- Key mismatch (HSBC might be using an outdated public key).\n" +
                "- Incorrect passphrase.\n" +
                "- Corrupted response data."
            );
        }

        console.log("Raw reportBase64 received:", reportBase64);
        return {};
    }
}

// Fetch transactions from HSBC with signing and encryption
async function fetchTransactions(transactionDate) {
    try {
        const clientPrivateKey = await loadPGPKey('./encryption/client-private.key');
        const hsbcPublicKey = await loadPGPKey('./encryption/hsbc-public.key');
        const passphrase = process.env.PGP_PASSPHRASE;

        const requestData = JSON.stringify({
            transactionDate,
            accountNumber: "339200000005",
            accountCountry: "GB",
        });

        console.log("Preparing request data for encryption...");
        const encryptedRequestData = await signAndEncryptData(requestData, clientPrivateKey, hsbcPublicKey, passphrase);

        console.log("Sending request to HSBC API...");
        const response = await axios.post(
            `${process.env.BANK_API_URL}/transactions`,
            { transactionsRequestBase64: encryptedRequestData },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'x-hsbc-client-id': process.env.CLIENT_ID,
                    'x-hsbc-client-secret': process.env.CLIENT_SECRET,
                    'x-hsbc-profile-id': process.env.PROFILE_ID,
                    'x-report-type': 'JSON',
                    'x-sort-order': 'DESC',
                },
            }
        );

        console.log("Response received from HSBC API.");
        const reportBase64 = response.data.reportBase64;

        if (reportBase64) {
            return await decryptAndVerifyResponse(reportBase64, clientPrivateKey, hsbcPublicKey, passphrase);
        } else {
            console.error("No reportBase64 field found in response.");
            return {};
        }
    } catch (error) {
        console.error('Error fetching transactions:', error.response ? error.response.data : error.message);
        return { error: 'Failed to retrieve transactions.' };
    }
}

// Endpoint to fetch transactions based on a date query parameter
app.get('/get-all-transactions', async (req, res) => {
    const transactionDate = req.query.date;
    if (!transactionDate) {
        return res.status(400).json({ error: "Missing 'date' query parameter in YYYY-MM-DD format." });
    }

    const transactionsData = await fetchTransactions(transactionDate);
    if (transactionsData.error) {
        return res.status(500).json(transactionsData);
    }

    res.json(transactionsData);
});

// Validate keys on startup
(async () => {
    try {
        console.log("Validating PGP keys...");
        await loadPGPKey('./encryption/client-private.key');
        await loadPGPKey('./encryption/client-public.key');
        await loadPGPKey('./encryption/hsbc-public.key');
        console.log("Keys successfully validated.");
    } catch (error) {
        console.error("Key validation failed. Exiting...");
        process.exit(1);
    }
})();

// Start the server
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access the transaction fetch API with a date filter at: http://localhost:${port}/get-all-transactions?date=YYYY-MM-DD`);
});
