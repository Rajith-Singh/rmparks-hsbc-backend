const express = require('express');
const axios = require('axios');
const fs = require('fs').promises;
const dotenv = require('dotenv');
const openpgp = require('openpgp');
const sql = require('mssql');
const moment = require('moment-timezone');  // Use moment-timezone for accurate timezone handling
const cors = require('cors');
const { format, parseISO, addDays } = require('date-fns');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');


dotenv.config();

const app = express();
const port = 3020;

// SQL Configuration
const dbConfig = {
    user: 'sa',
    password: 'rmparks@123', // Replace with your actual password
    server: '10.10.112.21', // The server name before the backslash
    port: 1433, // Port specified after the comma in Data Source
    database: 'ONLINE_BANK', // Replace with your actual database name
    options: {
        encrypt: false, // Adjust based on your server setup; typically false for on-prem servers
        trustServerCertificate: true, // Allow self-signed certificates
    },
};

// Function to get Sri Lanka Time (GMT+5:30)
const getSriLankaTime = () => {
    return moment().tz('Asia/Colombo').format('YYYY-MM-DD HH:mm:ss');
};

// ✅ **Winston Logger Setup with Daily Rotation**
const logTransport = new DailyRotateFile({
    filename: 'logs/app-%DATE%.log',  // Daily log files
    datePattern: 'YYYY-MM-DD',        // Log filename format
    zippedArchive: true,              // Compress old logs
    maxSize: '20m',                   // Max log file size before rotation
    maxFiles: '14d',                  // Keep logs for 14 days
});

const logger = winston.createLogger({
    level: 'info',
    transports: [
        logTransport,
        new winston.transports.Console({ format: winston.format.simple() }) // Console logging
    ],
    format: winston.format.combine(
        winston.format.printf(({ level, message }) => {
            return `${getSriLankaTime()} [${level.toUpperCase()}]: ${message}`;
        })
    ),
});

let lastCheckedDate = null;  // Keep track of the last checked date to trigger holiday checks only once a day

let cachedHolidays = {
    'LK': {},  // Sri Lanka
    'MV': {},  // Maldives
};

// Helper function to check if today is a new day
function isNewDay() {
    const sriLankaDate = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
    if (sriLankaDate !== lastCheckedDate) {
        lastCheckedDate = sriLankaDate;
        return true;
    }
    return false;
}

// Function to fetch holiday data from CALENDARIFIC API
async function fetchHolidayData(countryCode, date) {
    try {
        const year = date.year();
        const month = date.month() + 1;
        const day = date.date();

        const url = `https://calendarific.com/api/v2/holidays?&api_key=${process.env.CALENDARIFIC_API_KEY}&country=${countryCode}&year=${year}&month=${month}&day=${day}`;
        const response = await axios.get(url);
        
        // Store the holiday data for the country to avoid redundant API calls
        cachedHolidays[countryCode] = response.data.response.holidays.map(holiday => holiday.date.iso);
        console.log(`Fetched holidays for ${countryCode} on ${date.format('YYYY-MM-DD')}`);
        logger.info(`Fetched holidays for ${countryCode} on ${date.format('YYYY-MM-DD')}`);
    } catch (error) {
        console.error(`Error fetching holidays for ${countryCode}:`, error);
        logger.error(`Error fetching holidays for ${countryCode}: ${error.message}`);
    }
}

// Function to check if a given date is a holiday for a country
function isHoliday(date, countryCode) {
    const dateString = date.format('YYYY-MM-DD');
    if (!cachedHolidays[countryCode]) {
        return false;  // Return false if holidays have not been fetched for this country yet
    }
    return cachedHolidays[countryCode].includes(dateString);
}

async function storeTransactions(transactionData) {
    if (!Array.isArray(transactionData) || transactionData.length === 0) {
        console.error("No transactions to process.");
        return;
    }

    for (const transaction of transactionData) {
        const transactionDataItems = transaction.items;

        const transCode = generateTransCode();
        const collectionAcc = 'HSB';
        const bankCode = 'HSB';
        const branchCode = '7092001';
        const cOrD = transactionDataItems.creditDebitIndicator;
        const bankTransRef = transactionDataItems.transactionReference;
        const bankDate = transactionDataItems.valueDateTime;
        const amount = transactionDataItems.transactionAmount.amount;
        const dipstrName = null;

        const transactionInformation = transactionDataItems.transactionInformation;
        const custAccMatch = transactionInformation.match(/\/VA\/(\d{10,})\//);

        let custAcc, payCca, errorDescCode;

        if (custAccMatch && custAccMatch[1]) {
            const fullAccountNumber = custAccMatch[1];

            if (fullAccountNumber.length !== 10) {
                errorDescCode = 'CUSLN';
                logger.error(`Error Transaction Detected: Account number length is invalid. Details:
                TransCode: ${transCode},
                BankCode: ${bankCode},
                BranchCode: ${branchCode},
                CustAcc: ${fullAccountNumber},
                C_OR_D: ${cOrD},
                BankTransRef: ${bankTransRef},
                BankDate: ${bankDate},
                Amount: ${amount}`);

                try {
                    await insertTransactionError({
                        transCode,
                        errorDescCode,
                        bankCode,
                        branchCode,
                        custAcc: fullAccountNumber,
                        cOrD,
                        bankTransRef,
                        bankDate,
                        amount,
                    });
                    logger.info(`Error Transaction Successfully Inserted into TRANSACTION_ERROR_TMP: TransCode: ${transCode}, ErrorDescCode: ${errorDescCode}`);
                } catch (error) {
                    logger.error(`Failed to Insert Error Transaction into TRANSACTION_ERROR_TMP: TransCode: ${transCode}, Error: ${error.message}`);
                }
                continue;
            }

            custAcc = fullAccountNumber.slice(0, 6);
            const customerExists = await checkCustomerNumberExists(custAcc);

            if (!customerExists) {
                errorDescCode = 'CUSER';
                try {
                    logger.error(`Error Transaction Detected: Customer number does not exist. Details:
                    TransCode: ${transCode},
                    BankCode: ${bankCode},
                    BranchCode: ${branchCode},
                    CustAcc: ${custAcc},
                    C_OR_D: ${cOrD},
                    BankTransRef: ${bankTransRef},
                    BankDate: ${bankDate},
                    Amount: ${amount}`);

                    await insertTransactionError({
                        transCode,
                        errorDescCode,
                        bankCode,
                        branchCode,
                        custAcc,
                        cOrD,
                        bankTransRef,
                        bankDate,
                        amount,
                    });
                    logger.info(`Error Transaction Successfully Inserted into TRANSACTION_ERROR_TMP: TransCode: ${transCode}, ErrorDescCode: ${errorDescCode}`);
                } catch (error) {
                    logger.error(`Failed to Insert Error Transaction into TRANSACTION_ERROR_TMP: TransCode: ${transCode}, Error: ${error.message}`);
                }
                continue;
            }

            const accountTypeCode = fullAccountNumber.slice(6, 8);
            switch (accountTypeCode) {
                case '01':
                    payCca = 'R001';
                    break;
                case '03':
                    payCca = 'R003';
                    break;
                case '08':
                    payCca = 'R008';
                    break;
                default:
                    payCca = 'UNKNOWN';
                    break;
            }

            try {
                await insertTransaction({
                    transCode,
                    collectionAcc,
                    bankCode,
                    branchCode,
                    custAcc,
                    payCca,
                    cOrD,
                    bankTransRef,
                    bankDate,
                    amount,
                    dipstrName,
                });
                logger.info(`Inserted transaction into Transactions_TMP for ${transCode}`);
            } catch (error) {
                logger.error(`Failed to Insert Transaction into Transactions_TMP for ${transCode}:`, error);
            }
        }

        const systemHoliday = await isSystemHoliday(bankDate);

        if (systemHoliday) {
            const nextSystemWorkingDate = await getNextSystemWorkingDate(moment(bankDate));

            await insertTransaction({
                transCode,
                collectionAcc,
                bankCode,
                branchCode,
                custAcc,
                payCca,
                cOrD,
                bankTransRef,
                bankDate,
                amount,
                dipstrName
            });
            logger.info(`Inserted transaction into Transactions_TMP for ${transCode}`);

            await insertTransactionNonBusinessDate({
                transCode,
                collectionAcc,
                bankCode,
                branchCode,
                custAcc,
                payCca,
                cOrD,
                bankTransRef,
                bankDate,
                amount,
                dipstrName,
                nextSystemWorkingDate,
                reasonForNonBusinessDate: 'System Holiday'
            });
            logger.info(`Inserted transaction into Transactions_NonBusinessDates for ${transCode}`);
        }
    }
}



async function checkCustomerNumberExists(customerNumber) {
    try {
        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('CUSTOMER_NO', sql.NVarChar, customerNumber)
            .query('SELECT COUNT(*) AS count FROM TBL_MAS_CUSTOMER WHERE CUSTOMER_NO = @CUSTOMER_NO');
        return result.recordset[0].count > 0;
    } catch (error) {
        console.error('Error checking customer number existence:', error);
        return false;
    }
}

// Function to check if an error transaction already exists based on BANK_TRANS_REF
async function checkDuplicateTransactionError(bankTransRef) {
    try {
        logger.info(`Checking for duplicate transaction error with BANK_TRANS_REF: ${bankTransRef}`);

        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('BANK_TRANS_REF', sql.NVarChar, bankTransRef)
            .query('SELECT COUNT(*) AS count FROM TransactionError_TMP WHERE BANK_TRANS_REF = @BANK_TRANS_REF');

            const isDuplicate = result.recordset[0].count > 0;

            if (isDuplicate) {
                logger.warn(`Duplicate transaction error detected: BANK_TRANS_REF ${bankTransRef} already exists.`);
            } else {
                logger.info(`No duplicate found for BANK_TRANS_REF: ${bankTransRef}. Proceeding with insert.`);
            }
    
            return isDuplicate;
        } catch (error) {
            logger.error(`Error checking duplicate transaction error for BANK_TRANS_REF: ${bankTransRef}`, error);
            return false;
        }
    }


// Function to check if a transaction already exists in Transactions_TMP
async function checkDuplicateTransaction(bankTransRef) {
    try {
        logger.info(`Checking for duplicate transaction in Transactions_TMP with BANK_TRANS_REF: ${bankTransRef}`);

        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('BANK_TRANS_REF', sql.NVarChar, bankTransRef)
            .query('SELECT COUNT(*) AS count FROM Transactions_TMP WHERE BANK_TRANS_REF = @BANK_TRANS_REF');

        const isDuplicate = result.recordset[0].count > 0;

        if (isDuplicate) {
            logger.warn(`Duplicate transaction detected in Transactions_TMP: BANK_TRANS_REF ${bankTransRef} already exists.`);
        } else {
            logger.info(`No duplicate found in Transactions_TMP for BANK_TRANS_REF: ${bankTransRef}. Proceeding with insert.`);
        }

        return isDuplicate;
    } catch (error) {
        logger.error(`Error checking duplicate transaction in Transactions_TMP for BANK_TRANS_REF: ${bankTransRef}`, error);
        return false;
    }
}

// Function to check if a transaction already exists in Transactions_NonBusinessDates
async function checkDuplicateTransactionNonBusiness(bankTransRef) {
    try {
        logger.info(`Checking for duplicate transaction in Transactions_NonBusinessDates with BANK_TRANS_REF: ${bankTransRef}`);

        const pool = await sql.connect(dbConfig);
        const result = await pool.request()
            .input('BANK_TRANS_REF', sql.NVarChar, bankTransRef)
            .query('SELECT COUNT(*) AS count FROM Transactions_NonBusinessDates WHERE BANK_TRANS_REF = @BANK_TRANS_REF');

        const isDuplicate = result.recordset[0].count > 0;

        if (isDuplicate) {
            logger.warn(`Duplicate transaction detected in Transactions_NonBusinessDates: BANK_TRANS_REF ${bankTransRef} already exists.`);
        } else {
            logger.info(`No duplicate found in Transactions_NonBusinessDates for BANK_TRANS_REF: ${bankTransRef}. Proceeding with insert.`);
        }

        return isDuplicate;
    } catch (error) {
        logger.error(`Error checking duplicate transaction in Transactions_NonBusinessDates for BANK_TRANS_REF: ${bankTransRef}`, error);
        return false;
    }
}

async function insertTransactionError(transactionError) {
    try {
        // ✅ NEW: Check for duplicate transaction error before inserting
        const isDuplicate = await checkDuplicateTransactionError(transactionError.bankTransRef);

        if (isDuplicate) {
            logger.warn(`Skipping insert: Duplicate transaction error detected for BANK_TRANS_REF: ${transactionError.bankTransRef}`);
            console.warn(`Duplicate transaction error detected for BANK_TRANS_REF: ${transactionError.bankTransRef}. Skipping insert.`);
            return; // Exit function if duplicate exists
        }

        logger.info(`Inserting new transaction error for BANK_TRANS_REF: ${transactionError.bankTransRef}`);


        const pool = await sql.connect(dbConfig);
        const request = pool.request()
            .input('SYS_REF', sql.NVarChar, transactionError.transCode)
            .input('ERROR_DES_CODE', sql.NVarChar, transactionError.errorDescCode)
            .input('BANK_CODE', sql.NVarChar, transactionError.bankCode)
            .input('BRANCH_CODE', sql.NVarChar, transactionError.branchCode)
            .input('CUST_AC', sql.NVarChar, transactionError.custAcc || 'HSB')
            .input('C_OR_D', sql.NVarChar, transactionError.cOrD)
            .input('BANK_TRANS_REF', sql.NVarChar, transactionError.bankTransRef)
            .input('BANK_DATE', sql.DateTime, transactionError.bankDate)
            .input('AMOUNT', sql.Decimal(18, 2), transactionError.amount)
            .input('ENTERED_BY', sql.NVarChar, 'WBSER')
            .input('ENTERED_DATE', sql.DateTime, new Date())
            .input('STATUS', sql.NVarChar, 'OPN')
            .input('BANK_AUTH', sql.NVarChar, '80885630')
            .input('DIPSTR_NAME', sql.NVarChar, null);

        const result = await request.query(`
            INSERT INTO TransactionError_TMP 
            (SYS_REF, ERROR_DES_CODE, BANK_CODE, BRANCH_CODE, CUST_AC, C_OR_D, BANK_TRANS_REF, BANK_DATE, AMOUNT, DIPSTR_NAME, ENTERED_BY, ENTERED_DATE, STATUS) 
            VALUES (@SYS_REF, @ERROR_DES_CODE, @BANK_CODE, @BRANCH_CODE, @CUST_AC, @C_OR_D, @BANK_TRANS_REF, @BANK_DATE, @AMOUNT, @DIPSTR_NAME, @ENTERED_BY, @ENTERED_DATE, @STATUS)
        `);

        if (result.rowsAffected[0] > 0) {
            logger.info(`Transaction error successfully inserted into TransactionError_TMP for BANK_TRANS_REF: ${transactionError.bankTransRef}`);
        } else {
            logger.warn(`Insert operation completed, but no rows were affected for BANK_TRANS_REF: ${transactionError.bankTransRef}`);
        }

        console.info(`Transaction error inserted successfully for BANK_TRANS_REF: ${transactionError.bankTransRef}`, result.rowsAffected);
    } catch (error) {
        logger.error(`Error inserting transaction into TransactionError_TMP for BANK_TRANS_REF: ${transactionError.bankTransRef}`, error);
        logger.error('Transaction Details:', JSON.stringify(transactionError, null, 2));
        console.error('Error inserting transaction into TransactionError_TMP:', error.message);
        console.error('Transaction Details:', transactionError);
        console.error('SQL Request Values:', {
            transCode: transactionError.transCode,
            errorDescCode: transactionError.errorDescCode,
            bankCode: transactionError.bankCode,
            branchCode: transactionError.branchCode,
            custAcc: transactionError.custAcc,
            cOrD: transactionError.cOrD,
            bankTransRef: transactionError.bankTransRef,
            bankDate: transactionError.bankDate,
            amount: transactionError.amount,
        });
    }
}







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

    // Return the encrypted data as a base64 encoded string
    return Buffer.from(encrypted).toString('base64');
}

// Use Flask server to decrypt data
async function decryptWithPython(encryptedData) {
    try {
        const decodedData = Buffer.from(encryptedData, 'base64').toString('utf-8');
        const response = await axios.post('http://localhost:5000/decrypt', {
            data: decodedData
        });

        console.log('Decrypted Response:', JSON.stringify(response.data, null, 2)); // Log the full decrypted data
        return response.data;
    } catch (error) {
        console.error('Error in decrypting data with Flask server:', error);
        throw error;
    }
}


// Fetch transactions from HSBC with signing and encryption
async function fetchTransactions(transactionDate) {
    const clientPrivateKey = await loadPGPKey('rmparks-private-key.asc');
    const hsbcPublicKey = await loadPGPKey('hsbc-public-key.asc');
    const passphrase = 'Petrol@2025!Pipeline$Safety';

    const requestData = JSON.stringify({
        transactionDate,
        accountNumber: "012276648040",
        accountCountry: "LK",
    });

    const encryptedRequestData = await signAndEncryptData(requestData, clientPrivateKey, hsbcPublicKey, passphrase);

    const response = await axios.post(
        `${process.env.BANK_API_URL}/transactions`,
        { transactionsRequestBase64: encryptedRequestData },
        {
            headers: {
                'Content-Type': 'application/json',
                'x-hsbc-client-secret': process.env.CLIENT_SECRET,
                'x-hsbc-profile-id': process.env.PROFILE_ID,
                'x-report-type': 'JSON',
                'x-sort-order': 'DESC',
            },
        }
    );

    // Decrypt and log the response to check its structure
    const transactions = await decryptWithPython(response.data.reportBase64);
    console.log('Decrypted Transactions:', transactions); // Log the structure
    logger.info(`Fetched transactions for ${transactionDate}: ${transactions.length} transactions`);

    // Access the transaction data
    const transactionData = transactions.transactions.transaction || []; // Fallback to empty array if no transactions

    // Check if the result is an array
    if (!Array.isArray(transactionData)) {
        throw new Error('Decrypted data is not an array or is missing');
    }

    return transactionData; // Return the array of transactions
}


function generateTransCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 8; i++) {
        const randomIndex = Math.floor(Math.random() * chars.length);
        code += chars[randomIndex];
    }
    return code;
}


// Function to insert transaction into Transactions_TMP table
async function insertTransaction(transaction) {
    try {
        const isDuplicate = await checkDuplicateTransaction(transaction.bankTransRef);

        if (isDuplicate) {
            logger.warn(`Skipping insert: Duplicate transaction detected in Transactions_TMP for BANK_TRANS_REF: ${transaction.bankTransRef}`);
            return; // Exit function if duplicate exists
        }

        logger.info(`Inserting new transaction into Transactions_TMP for BANK_TRANS_REF: ${transaction.bankTransRef}`);

        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('TRANS_CODE', sql.NVarChar, transaction.transCode)
            .input('COLLECTION_AC', sql.NVarChar, transaction.collectionAcc)
            .input('BANK_CODE', sql.NVarChar, transaction.bankCode)
            .input('BRANCH_CODE', sql.NVarChar, transaction.branchCode)
            .input('CUST_AC', sql.NVarChar, transaction.custAcc)
            .input('PAY_CCA', sql.NVarChar, transaction.payCca)
            .input('C_OR_D', sql.NVarChar, transaction.cOrD)
            .input('BANK_TRANS_REF', sql.NVarChar, transaction.bankTransRef)
            .input('BANK_DATE', sql.DateTime, transaction.bankDate)
            .input('AMOUNT', sql.Decimal(18, 2), transaction.amount)
            .input('DIPSTR_NAME', sql.NVarChar, transaction.dipstrName)
            .query('INSERT INTO Transactions_TMP (TRANS_CODE, COLLECTION_AC, BANK_CODE, BRANCH_CODE, CUST_AC, PAY_CCA, C_OR_D, BANK_TRANS_REF, BANK_DATE, AMOUNT, DIPSTR_NAME) VALUES (@TRANS_CODE, @COLLECTION_AC, @BANK_CODE, @BRANCH_CODE, @CUST_AC, @PAY_CCA, @C_OR_D, @BANK_TRANS_REF, @BANK_DATE, @AMOUNT, @DIPSTR_NAME)');
            logger.info(`Transaction successfully inserted into Transactions_TMP for BANK_TRANS_REF: ${transaction.bankTransRef}`);

    } catch (error) {
        logger.error(`Error inserting transaction into Transactions_TMP for BANK_TRANS_REF: ${transaction.bankTransRef}`, error);
        console.error('Error inserting transaction into Transactions_TMP:', error);
    }
}

// Function to insert transaction into Transactions_NonBusinessDates table
async function insertTransactionNonBusinessDate(transaction) {
    try {
        // ✅ NEW: Check for duplicate transaction before inserting
        const isDuplicate = await checkDuplicateTransactionNonBusiness(transaction.bankTransRef);

        if (isDuplicate) {
            logger.warn(`Skipping insert: Duplicate transaction detected in Transactions_NonBusinessDates for BANK_TRANS_REF: ${transaction.bankTransRef}`);
            return; // Exit function if duplicate exists
        }

        logger.info(`Inserting new transaction into Transactions_NonBusinessDates for BANK_TRANS_REF: ${transaction.bankTransRef}`);

        const pool = await sql.connect(dbConfig);
        await pool.request()
            .input('TRANS_CODE', sql.NVarChar, transaction.transCode)
            .input('COLLECTION_AC', sql.NVarChar, transaction.collectionAcc)
            .input('BANK_CODE', sql.NVarChar, transaction.bankCode)
            .input('BRANCH_CODE', sql.NVarChar, transaction.branchCode)
            .input('CUST_AC', sql.NVarChar, transaction.custAcc)
            .input('PAY_CCA', sql.NVarChar, transaction.payCca)
            .input('C_OR_D', sql.NVarChar, transaction.cOrD)
            .input('BANK_TRANS_REF', sql.NVarChar, transaction.bankTransRef)
            .input('BANK_DATE', sql.DateTime, transaction.bankDate)
            .input('AMOUNT', sql.Decimal(18, 2), transaction.amount)
            .input('DIPSTR_NAME', sql.NVarChar, transaction.dipstrName)
            .input('NEXT_SYSTEM_WORKING_DATE', sql.Date, transaction.nextSystemWorkingDate)
            .input('REASON_FOR_NON_BUSINESS_DATE', sql.NVarChar, transaction.reasonForNonBusinessDate)
            .query('INSERT INTO Transactions_NonBusinessDates (TRANS_CODE, COLLECTION_AC, BANK_CODE, BRANCH_CODE, CUST_AC, PAY_CCA, C_OR_D, BANK_TRANS_REF, BANK_DATE, AMOUNT, DIPSTR_NAME, NEXT_SYSTEM_WORKING_DATE, REASON_FOR_NON_BUSINESS_DATE) VALUES (@TRANS_CODE, @COLLECTION_AC, @BANK_CODE, @BRANCH_CODE, @CUST_AC, @PAY_CCA, @C_OR_D, @BANK_TRANS_REF, @BANK_DATE, @AMOUNT, @DIPSTR_NAME, @NEXT_SYSTEM_WORKING_DATE, @REASON_FOR_NON_BUSINESS_DATE)');
            logger.info(`Transaction successfully inserted into Transactions_NonBusinessDates for BANK_TRANS_REF: ${transaction.bankTransRef}`);
        } catch (error) {
            logger.error(`Error inserting transaction into Transactions_NonBusinessDates for BANK_TRANS_REF: ${transaction.bankTransRef}`, error);
        console.error('Error inserting transaction into Transactions_NonBusinessDates:', error);
    }
}


// Check if today is a holiday for both Sri Lanka (LK) and Maldives (MV)
async function isSystemHoliday(date) {
    // Ensure date is a moment object
    const momentDate = moment(date);  // Convert to moment if not already

    const sriLankaDate = momentDate.tz('Asia/Colombo').format('YYYY-MM-DD');
    const maldivesDate = momentDate.tz('Indian/Maldives').format('YYYY-MM-DD');

    const isSriLankaHoliday = cachedHolidays['LK'].includes(sriLankaDate);
    const isMaldivesHoliday = cachedHolidays['MV'].includes(maldivesDate);

    // Log the holiday status for Sri Lanka and Maldives
    logger.info(`Holiday check for ${momentDate.format('YYYY-MM-DD')}: Sri Lanka holiday = ${isSriLankaHoliday}, Maldives holiday = ${isMaldivesHoliday}`);

    // Determine and log whether it is a system holiday
    if (isSriLankaHoliday || isMaldivesHoliday) {
        logger.info(`System holiday on ${momentDate.format('YYYY-MM-DD')} due to ${isSriLankaHoliday ? 'Sri Lanka' : 'Maldives'} holiday.`);
        return true;
    } else {
        logger.info(`No system holiday on ${momentDate.format('YYYY-MM-DD')}`);
        return false;
    }
}







// Helper function to check if the bank is working on a given day
function isBankWorking(date, holidays, weekendDays) {
    const day = date.day();
    const isWeekend = weekendDays.includes(day);
    const isHoliday = holidays.includes(date.format('YYYY-MM-DD'));
    return !isWeekend && !isHoliday;
}


// Function to get the next system working date
async function getNextSystemWorkingDate(date) {
    let nextWorkingDate = moment(date).add(1, 'days');

    while (await isSystemHoliday(nextWorkingDate)) {
        nextWorkingDate = nextWorkingDate.add(1, 'days');
    }

    return nextWorkingDate.format('YYYY-MM-DD');
}


// Fetch the holiday list from Calendarific API for the given country
async function getHolidayList(countryCode, date) {
    try {
        const year = date.year();
        const month = date.month() + 1;
        const day = date.date();

        const url = `https://calendarific.com/api/v2/holidays?&api_key=${process.env.CALENDARIFIC_API_KEY}&country=${countryCode}&year=${year}&month=${month}&day=${day}`;
        const response = await axios.get(url);
        return response.data.response.holidays.map(holiday => holiday.date.iso);
    } catch (error) {
        console.error(`Error fetching holidays for ${countryCode}:`, error);
        return [];
    }
}




app.use(cors());

//Fetch transaction information from the tra table
app.get('/transactions', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig); // Connect to the database using `dbConfig`

        // Query to fetch transactions
        const result = await pool.request().query(`
            SELECT 
                TRANS_CODE AS id,
                BANK_TRANS_REF AS transactionReference,
                CUST_AC AS transactionInformation,
                AMOUNT AS amount,
                C_OR_D AS creditDebitIndicator,
                ENTERED_DATE AS valueDateTime
            FROM TBL_TRANSACTION
            WHERE BANK_CODE = 'HSB'
        `);

        // Respond with the fetched data
        res.json({ transactions: result.recordset });
        await pool.close(); // Close the database connection
    } catch (error) {
        console.error('Error fetching transactions for the frontend:', error);
        res.status(500).json({ error: 'Failed to fetch transactions from the database.' });
    }
});



// Fetch transaction information from the Transactions_NonBusinessDates table
app.get('/holiday-transactions', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig); // Connect to the database using `dbConfig`

        // Query to fetch transactions from the Transactions_NonBusinessDates table
        const result = await pool.request().query(`
            SELECT 
                TRANS_CODE AS id,
                BANK_TRANS_REF AS transactionReference,
                CUST_AC AS transactionInformation,
                AMOUNT AS amount,
                C_OR_D AS creditDebitIndicator,
                BANK_DATE AS valueDateTime,
                NEXT_SYSTEM_WORKING_DATE As nextSystemWorkingDate
            FROM Transactions_NonBusinessDates
            WHERE BANK_CODE = 'HSB'
        `);

        // Respond with the fetched data
        res.json({ transactions: result.recordset });
        await pool.close(); // Close the database connection
    } catch (error) {
        console.error('Error fetching non-business date transactions for the frontend:', error);
        res.status(500).json({ error: 'Failed to fetch non-business date transactions from the database.' });
    }
});


// Fetch transaction information from the TBL_TRANSACTION_ERROR table
app.get('/error-transactions', async (req, res) => {
    try {
        const pool = await sql.connect(dbConfig); // Connect to the database using `dbConfig`

        // Query to fetch transactions from the TBL_TRANSACTION_ERROR table
        const result = await pool.request().query(`
            SELECT 
                SYS_REF AS id,
                ERROR_DES_CODE AS errorDesCode,
                BANK_TRANS_REF AS transactionReference,
                CUST_AC AS transactionInformation,
                AMOUNT AS amount,
                C_OR_D AS creditDebitIndicator,
                ENTERED_DATE AS valueDateTime
            FROM TBL_TRANSACTION_ERROR
            WHERE BANK_CODE = 'HSB'
        `);

        // Respond with the fetched data
        res.json({ transactions: result.recordset });
        await pool.close(); // Close the database connection
    } catch (error) {
        console.error('Error fetching error transactions for the frontend:', error);
        res.status(500).json({ error: 'Failed to fetch error transactions from the database.' });
    }
});


// API Endpoint to Fetch Transactions
app.get('/get-all-transactions', async (req, res) => {
    const transactionDate = req.query.date;
    if (!transactionDate) {
        return res.status(400).json({ error: "Missing 'date' query parameter in YYYY-MM-DD format." });
    }

    try {
        // Fetch transactions from HSBC for the specified date
        logger.info(`Fetching transactions for date: ${transactionDate}`);
        const transactionsData = await fetchTransactions(transactionDate);

        // Check for system holiday date and insert accordingly
        const systemHolidayDate = await getNextSystemWorkingDate(moment(transactionDate));
        await storeTransactions(transactionsData, systemHolidayDate);

        // Return the transactions data to the client
        res.json(transactionsData);
    } catch (error) {
        console.error('Error fetching transactions:', error);
        res.status(500).json({ error: 'Failed to retrieve transactions due to server error.' });
    }
});

// Set an interval to check if it's a new day and call the API for transactions
setInterval(async () => {
    const today = moment().tz('Asia/Colombo').format('YYYY-MM-DD');
    logger.info(`Checking transactions for ${today}`);

    // Always call get-all-transactions every minute
    try {
        const response = await axios.get(`http://localhost:3020/get-all-transactions?date=${today}`);
        console.log(`Transactions for ${today}:`, response.data);  // Handle the response as needed
        logger.info(`Transactions for ${today}: ${response.data.length} transactions`);
    } catch (error) {
        console.error('Error calling get-all-transactions API:', error);
    }

    // If it's a new day, optimize by calling the CALENDARIFIC API
    if (isNewDay()) {
        try {
            // Fetch holiday data for Sri Lanka and Maldives
            logger.info("New day detected, fetching holiday data...");
            await fetchHolidayData('LK', moment());
            await fetchHolidayData('MV', moment());
        } catch (error) {
            console.error('Error fetching holiday data:', error);
        }
    }
}, 1 * 60 * 1000); // Check every minute (60000 ms)

// Start Express server
app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
    logger.info(`Server running on http://localhost:${port}`);
});