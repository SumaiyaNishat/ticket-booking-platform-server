const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 3000;
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const admin = require("firebase-admin");

const serviceAccount = require("./ticket-booking-platform-firebase-adminsdk.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// middleware
app.use(express.json());
app.use(cors());

const verifyFBToken = async (req, res, next) => {
  // console.log('headers in the middleware', req.headers.authorization)
  const token = req.headers.authorization;

  if (!token) {
    return res.status(401).send({ message: "unauthorized access" });
  }

  try {
    const idToken = token.split(" ")[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    console.log("decoded in the token", decoded);
    req.decoded_email = decoded.email;
    next();
  } catch (err) {
    return res.status(401).send({ message: "unauthorized access" });
  }
};

app.get("/", (req, res) => {
  res.send("ticket booking platform!");
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.vodyl0g.mongodb.net/?appName=Cluster0`;
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const db = client.db("ticket_db");
    const usersCollection = db.collection("users");
    const ticketsCollection = db.collection("tickets");
    const bookingsCollection = db.collection("bookings");
    const transactionsCollection = db.collection("transactions");

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;

      const user = await usersCollection.findOne({ email });

      if (!user || user.role !== "admin") {
        return res.status(403).send({
          message: "Forbidden access",
        });
      }

      next();
    };

    module.exports = verifyAdmin;

    // users related apis
    app.post("/users", async (req, res) => {
      const user = req.body;
      user.role = "user";
      user.createdAt = new Date();

      const email = user.email;
      const userExists = await usersCollection.findOne({ email });

      if (userExists) {
        return res.send({ message: "user exists" });
      }

      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    app.get("users/:email/role", async (req, res) => {
      const email = req.params.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      res.send({ role: user?.role || "user" });
    });

    // ticket api
    app.get("/tickets", async (req, res) => {
      const query = {};

      const { email } = req.query;
      if (email) {
        query.vendorEmail = email;
      }

      const options = { sort: { createdAt: -1 } };

      const cursor = ticketsCollection.find(query, options);
      const result = await cursor.toArray();
      res.send(result);
    });
    app.post("/tickets", async (req, res) => {
      const ticket = req.body;

      ticket.createdAt = new Date();
      ticket.status = "pending";
      const result = await ticketsCollection.insertOne(ticket);
      res.send(result);
    });

    app.delete("/ticket/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };

      const result = await ticketsCollection.deleteOne(query);
      res.send(result);
    });

    app.get("/tickets/:id", async (req, res) => {
      const id = req.params.id;

      const result = await ticketsCollection.findOne({
        _id: new ObjectId(id),
      });

      res.send(result);
    });

    app.get("/latestTickets", async (req, res) => {
      const result = await ticketsCollection
        .find({})
        .sort({ createdAt: -1 })
        .limit(8)
        .toArray();

      res.send(result);
    });

    app.post("/bookings", async (req, res) => {
      const booking = req.body;

      booking.status = "pending";
      booking.createdAt = new Date();
      const result = await bookingsCollection.insertOne(booking);

      res.send(result);
    });

    // get my booking api
    app.get("/myBookings", async (req, res) => {
      const email = req.query.userEmail;

      const result = await bookingsCollection
        .find({ userEmail: email })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    app.get("/bookings", async (req, res) => {
      const email = req.query.vendorEmail;

      const result = await bookingsCollection
        .find({ vendorEmail: email })
        .toArray();

      res.send(result);
    });

    app.patch("/bookings/accept/:id", async (req, res) => {
      const id = req.params.id;

      const result = await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "accepted" } },
      );

      res.send(result);
    });

    app.patch("/bookings/reject/:id", async (req, res) => {
      const id = req.params.id;

      const result = await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        { $set: { status: "rejected" } },
      );

      res.send(result);
    });

    app.get("/tickets", async (req, res) => {
      const result = await ticketsCollection
        .find({ status: "approved" })
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    app.patch("/tickets/approve/:id", async (req, res) => {
      const id = req.params.id;

      const result = await ticketsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { status: "approved" },
        },
      );

      res.send(result);
    });

    app.patch("/tickets/reject/:id", async (req, res) => {
      const id = req.params.id;

      const result = await ticketsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { status: "rejected" },
        },
      );

      res.send(result);
    });

    // Get all users
    app.get("/users", async (req, res) => {
      const result = await usersCollection.find().toArray();

      res.send(result);
    });

    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const roleInfo = req.body;
        const query = { _id: new ObjectId(id) };
        const updatedDoc = {
          $set: {
            role: roleInfo.role,
          },
        };
        const result = await userCollection.updateOne(query, updatedDoc);
        res.send(result);
      },
    );

    // Make Admin
    app.patch("/users/admin/:id", async (req, res) => {
      const id = req.params.id;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { role: "admin" },
        },
      );

      res.send(result);
    });

    // Make Vendor
    app.patch("/users/vendor/:id", async (req, res) => {
      const id = req.params.id;

      const result = await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { role: "vendor" },
        },
      );

      res.send(result);
    });

    // Mark vendor as Fraud
    app.patch("/users/fraud/:id", async (req, res) => {
      const id = req.params.id;

      // mark fraud
      await usersCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: { isFraud: true },
        },
      );

      // hide vendor tickets
      await ticketsCollection.updateMany(
        { vendorId: id },
        {
          $set: { status: "rejected" },
        },
      );

      res.send({ success: true });
    });

    // payment
    app.get("/booking/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await bookingsCollection.findOne(query);
      res.send(result);
    });

    app.patch("/bookings/pay/:id", async (req, res) => {
      try {
        const id = req.params.id;

        // find booking
        const booking = await bookingsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!booking) {
          return res.status(404).send({
            success: false,
            message: "Booking not found",
          });
        }

        // update booking status
        await bookingsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: "paid",
              paidAt: new Date(),
            },
          },
        );

        // reduce ticket quantity
        await ticketsCollection.updateOne(
          { _id: new ObjectId(booking.ticketId) },
          {
            $inc: {
              quantity: -booking.bookingQuantity,
            },
          },
        );

        // save transaction history
        const transaction = {
          transactionId: "TXN-" + Date.now(),

          bookingId: booking._id.toString(),

          userEmail: booking.userEmail,

          ticketTitle: booking.ticketTitle,

          amount: booking.unitPrice * booking.bookingQuantity,

          paymentDate: new Date(),
        };

        await transactionsCollection.insertOne(transaction);

        res.send({
          success: true,
          message: "Payment completed and transaction saved",
        });
      } catch (error) {
        console.log("Payment update error:", error);

        res.status(500).send({
          success: false,
          message: error.message,
        });
      }
    });

    // user transaction history API
    app.get("/transactions", verifyFBToken, async (req, res) => {
      const email = req.query.email;

      const result = await transactionsCollection
        .find({ userEmail: email })
        .sort({ paymentDate: -1 })
        .toArray();

      res.send(result);
    });

    // payment related apis
    app.post("/create-checkout-session", async (req, res) => {
      const paymentInfo = req.body;
      const amount =
        parseInt(paymentInfo.unitPrice) *
        parseInt(paymentInfo.bookingQuantity) *
        100;
      const session = await stripe.checkout.sessions.create({
        line_items: [
          {
            // Provide the exact Price ID (for example, price_1234) of the product you want to sell
            price_data: {
              currency: "USD",
              unit_amount: amount,
              product_data: {
                name: paymentInfo.ticketTitle,
              },
            },
            quantity: 1,
          },
        ],
        customer_email: paymentInfo.userEmail,
        mode: "payment",
        metadata: {
          bookingId: paymentInfo.bookingId,

          ticketId: paymentInfo.ticketId,
          bookingQuantity: paymentInfo.bookingQuantity,
        },
        success_url: `${process.env.SITE_DOMAIN}/dashboard/payment-success?bookingId=${paymentInfo.bookingId}`,
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/payment-cancelled`,
      });

      console.log(session);
      res.send({ url: session.url });
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`);
});
