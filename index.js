const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 3000;
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

// middleware
app.use(express.json());
app.use(cors());

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
    const ticketsCollection = db.collection("tickets");
    const bookingsCollection = db.collection("bookings");

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

    // payment
    app.get("/booking/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await bookingsCollection.findOne(query);
      res.send(result);
    });

    app.patch("/bookings/pay/:id", async (req, res) => {
      const id = req.params.id;

      const { ticketId, bookingQuantity } = req.body;

      await bookingsCollection.updateOne(
        { _id: new ObjectId(id) },
        {
          $set: {
            status: "paid",
            paidAt: new Date(),
          },
        },
      );

      await ticketsCollection.updateOne(
        { _id: new ObjectId(ticketId) },
        {
          $inc: {
            quantity: -bookingQuantity,
          },
        },
      );

      res.send({ success: true });
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
        cancel_url: `${process.env.SITE_DOMAIN}/dashboard/myBookedTickets`,
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
