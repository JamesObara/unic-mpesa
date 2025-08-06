const express = require("express");
const axios = require("axios");
const moment = require("moment");
const cors = require("cors");
const fs = require("fs");
require('dotenv').config();
const sdk = require("node-appwrite");

const client = new sdk.Client();

client
    .setEndpoint(process.env.ENDPOINT)
    .setProject(process.env.PROJECTID)
    .setKey(process.env.APIKEY);

const app = express();

// Middleware
app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const port = process.env.PORT || 4000;


// Utility function to get access token
async function getAccessToken() {
  const consumer_key = process.env.CONSUMER_KEY;
  const consumer_secret = process.env.CONSUMER_SECRET;
  
  if (!consumer_key || !consumer_secret) {
    throw new Error('Missing M-Pesa credentials in environment variables');
  }

  const url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials";
  const auth = "Basic " + Buffer.from(`${consumer_key}:${consumer_secret}`).toString("base64");

  console.log("AUTH HEADER:", auth);


  try {
    const response = await axios.get(url, {
      headers: { Authorization: auth }
    });
    return response.data.access_token;
  } catch (error) {
    console.error('Error getting access token:', error.message);
    throw new Error('Failed to get access token');
  }
}

// Middleware to attach access token
const attachAccessToken = async (req, res, next) => {
  try {
    const accessToken = await getAccessToken();
    req.accessToken = accessToken;
    next();
  } catch (error) {
    res.status(500).json({ error: 'Failed to authenticate with M-Pesa API' });
  }
};

// Validation middleware
const validateStkPushRequest = (req, res, next) => {
  const { phoneNumber, amount } = req.body;
  
  if (!phoneNumber || !amount) {
    return res.status(400).json({ 
      error: 'Phone number and payable amount are required' 
    });
  }

  // Basic phone number validation (Kenyan format)
  if (!/^254\d{9}$/.test(phoneNumber)) {
    return res.status(400).json({ 
      error: 'Invalid phone number format. Use 254XXXXXXXXX' 
    });
  }

  // Amount validation
  if (isNaN(amount) || amount <= 0) {
    return res.status(400).json({ 
      error: 'Invalid amount. Must be a positive number' 
    });
  }

  next();
};

// Routes
app.get("/", (req, res) => {
  res.json({ 
    message: "M-Pesa Daraja API For KSU App", 
    status: "active",
    timestamp: moment().format("YYYY-MM-DD HH:mm:ss")
  });
});

// Get access token (for testing)
app.get("/access_token", async (req, res) => {
  try {
    const accessToken = await getAccessToken();
    res.json({ access_token: accessToken });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/test-appwrite", async (req, res) => {
  try {
    const databases = new sdk.Databases(client);

    // Test connection by trying to list documents from your collection
    const response = await databases.listDocuments(
      process.env.APPWRITE_DATABASE_ID,
      "businesses", // Fixed: Use string collection ID
    );

    res.json({
      success: true,
      message: "Appwrite connection successful",
      count: response.total,
      documents: response.documents
    });
  } catch (error) {
    console.error("Appwrite test error:", error.message);
    res.status(500).json({ 
      success: false,
      error: "Failed to connect to Appwrite or fetch data",
      details: error.message 
    });
  }
});
const pendingTransactions = new Map()
// STK Push endpoint
app.post("/stkpush", validateStkPushRequest, attachAccessToken, async (req, res) => {
  // console.log("req.body",req.body);
  const { phoneNumber, amount,accountReference,transactionDesc  } = req.body;
  
    // console.log("Received user_id:", user_id);

  try {
    const timestamp = moment().format("YYYYMMDDHHmmss");
    const businessShortCode = process.env.BUSINESSSHORTCODE;
    const passkey = process.env.PASSKEY;
    
    const password = Buffer.from(
      businessShortCode + passkey + timestamp
    ).toString("base64");

    const stkPushUrl = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest";
    
    const requestData = {
      BusinessShortCode: businessShortCode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: "CustomerPayBillOnline",
      Amount: amount,
      PartyA: phoneNumber,
      PartyB: businessShortCode,
      PhoneNumber: phoneNumber,
      CallBackURL: process.env.CALLBACKURI,
      AccountReference: accountReference,
      TransactionDesc: transactionDesc
    };

    const response = await axios.post(stkPushUrl, requestData, {
      headers: {
        Authorization: `Bearer ${req.accessToken}`,
        "Content-Type": "application/json"
      }
    });

    if (response.data.CheckoutRequestID) {
      // pendingTransactions.set(response.data.CheckoutRequestID, {
      //   user_id: user_id,
      //   phone_number: phone_number,
      //   amount: amount
      // });
      
      // console.log(`Stored user_id ${user_id} for CheckoutRequestID: ${response.data.CheckoutRequestID}`);
    }

    res.json({
      success: true,
      message: "STK push sent successfully. Please check your phone.",
      data: response.data
    });

  } catch (error) {
    console.error('STK Push error:', error.response?.data || error.message);
    res.status(500).json({
      success: false,
      error: "Failed to process STK push request"
    });
  }
});

// STK Push callback
app.post("/stk_callback", async (req, res) => {
  try {
    const callbackData = req.body.Body.stkCallback;
    console.log('✅ STK Callback received:', callbackData);

    const checkoutRequestID = callbackData.CheckoutRequestID;
    const storedData = pendingTransactions.get(checkoutRequestID);

    const databases = new sdk.Databases(client);

    const baseTransaction = {
      checkoutRequestID: checkoutRequestID,
      merchantRequestID: callbackData.MerchantRequestID,
      resultCode: callbackData.ResultCode,
      resultDesc: callbackData.ResultDesc,
      mpesaReceiptNumber: null,
      amount: 1,
      transactionDate: null,
      phoneNumber: null,
      userId: "686c2e0f0027634a8e93",
    };

    // Extract metadata
    if (callbackData.CallbackMetadata) {
      callbackData.CallbackMetadata.Item.forEach(item => {
        if (item.Name === "Amount") baseTransaction.amount = item.Value;
        if (item.Name === "MpesaReceiptNumber") baseTransaction.mpesaReceiptNumber = item.Value;
        if (item.Name === "TransactionDate") baseTransaction.transactionDate = item.Value;
        if (item.Name === "PhoneNumber") baseTransaction.phoneNumber = item.Value;
      });
    }

    // Save to Appwrite
    // const saved = await databases.createDocument(
    //   process.env.APPWRITE_DATABASE_ID,
    //   process.env.TRANSACTIONS_COLLECTION_ID,
    //   "unique()",
    //   baseTransaction
    // );

    // console.log("✅ Transaction saved to Appwrite:", saved.$id);

    // if (storedData) {
    //   console.log("Payment result for user_id:", storedData.user_id);
    //   pendingTransactions.delete(checkoutRequestID);
    // } else {
    //   console.log("⚠️ No stored data found for this CheckoutRequestID");
    // }

    res.sendStatus(200);
  } catch (error) {
    console.error('Callback processing error:', error.message);
    res.sendStatus(500);
  }
});

// Register URLs for C2B (if needed)
app.post("/registerurl", attachAccessToken, async (req, res) => {
  try {
    const url = "https://sandbox.safaricom.co.ke/mpesa/c2b/v1/registerurl";
    
    const response = await axios.post(url, {
      ShortCode: process.env.BUSINESSSHORTCODE,
      ResponseType: "Completed",
      ConfirmationURL: process.env.CONFIRMATIONURL,
      ValidationURL: process.env.VALIDATIONURL
    }, {
      headers: {
        Authorization: `Bearer ${req.accessToken}`
      }
    });
    
    res.json(response.data);
  } catch (error) {
    console.error('URL registration error:', error.response?.data || error.message);
    res.status(500).json({ error: "Failed to register URLs" });
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "healthy", 
    timestamp: moment().format("YYYY-MM-DD HH:mm:ss") 
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.stack);
  res.status(500).json({ error: 'Internal server error' });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});


// Start server
app.listen(port, '0.0.0.0', () => {
  console.log(`M-Pesa API server running at http://localhost:${port}/`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});