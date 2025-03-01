const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const openpgp = require('openpgp');

dotenv.config();

const app = express();
const port = 3007;

// Load PGP keys from specified file paths
async function loadPGPKey(filePath) {
    try {
        const fullPath = `./encryption/${filePath}`;
        const key = await fs.readFile(fullPath, 'utf8');
        return key;
    } catch (error) {
        console.error(`Error loading PGP key from ${filePath}:`, error);
        throw error;
    }
}

// Sign and encrypt the payload with OpenPGP
async function signAndEncryptData(data, clientPrivateKeyArmored, hsbcPublicKeyArmored, passphrase) {
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

    return Buffer.from(encrypted).toString('base64');
}

// Use Flask server to decrypt data
async function decryptWithPython(encryptedData) {
    try {
        const decodedData = Buffer.from(encryptedData, 'base64').toString('utf-8');
        const response = await axios.post('http://localhost:5000/decrypt', {
            data: decodedData
        });
        return response.data;
    } catch (error) {
        console.error('Error in decrypting data with Flask server:', error);
        throw error;
    }
}

// Fetch transactions from HSBC with signing and encryption
async function fetchTransactions(transactionDate) {
    const clientPrivateKey = await loadPGPKey('client-private.pem');
    const hsbcPublicKey = await loadPGPKey('hsbc-public.pem');
    const passphrase = '1password';

    const requestData = JSON.stringify({
        transactionDate,
        accountNumber: "339200000005",
        accountCountry: "GB",
    });

    const encryptedRequestData = await signAndEncryptData(requestData, clientPrivateKey, hsbcPublicKey, passphrase);
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

    const transactions = await decryptWithPython(response.data.reportBase64);
    return transactions;
}

// Route to get transactions filtered by date and time range
app.get('/get-all-transactions', async (req, res) => {
    const { startDateTime, endDateTime } = req.query;

    if (!startDateTime || !endDateTime) {
        return res.status(400).json({ error: "Provide 'startDateTime' and 'endDateTime' in YYYY-MM-DDTHH:mm:ss format." });
    }

    try {
        // Extract only the date part from startDateTime to fetch transactions for that day
        const transactionDate = startDateTime.split('T')[0];

        // Fetch all transactions for the given date
        const transactionsData = await fetchTransactions(transactionDate);

        // Convert start and end times to Date objects for filtering
        const startDate = new Date(startDateTime);
        const endDate = new Date(endDateTime);

        // Filter transactions based on date-time range
        const filteredTransactions = transactionsData.filter(txn => {
            const txnDate = new Date(txn.date); // Assuming transactions have a 'date' field in ISO format
            return txnDate >= startDate && txnDate <= endDate;
        });

        res.json(filteredTransactions);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to retrieve transactions due to server error.' });
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`Access the transaction fetch API with a date-time filter at:`);
    console.log(`http://localhost:${port}/get-all-transactions?startDateTime=2025-03-01T09:00:00&endDateTime=2025-03-01T12:00:00`);
});
