import { Router, type IRouter } from "express";
import healthRouter from "./health.js";
import authRouter from "./auth.js";
import companiesRouter from "./companies.js";
import usersRouter from "./users.js";
import clientsRouter from "./clients.js";
import jobsRouter from "./jobs.js";
import timeclockRouter from "./timeclock.js";
import invoicesRouter from "./invoices.js";
import scorecardsRouter from "./scorecards.js";
import payrollRouter from "./payroll.js";
import loyaltyRouter from "./loyalty.js";
import dashboardRouter from "./dashboard.js";
import adminRouter from "./admin.js";

const router: IRouter = Router();

router.use(healthRouter);
router.use("/auth", authRouter);
router.use("/companies", companiesRouter);
router.use("/users", usersRouter);
router.use("/clients", clientsRouter);
router.use("/jobs", jobsRouter);
router.use("/timeclock", timeclockRouter);
router.use("/invoices", invoicesRouter);
router.use("/scorecards", scorecardsRouter);
router.use("/payroll", payrollRouter);
router.use("/loyalty", loyaltyRouter);
router.use("/dashboard", dashboardRouter);
router.use("/admin", adminRouter);

export default router;
