import PDFDocument from "pdfkit";
import fs from "fs";
import path from "path";

interface JobPdfData {
  jobId: number;
  companyName: string;
  clientName: string;
  clientAddress: string;
  serviceType: string;
  scheduledDate: string;
  scheduledTime: string | null;
  assignedUserName: string | null;
  baseFee: string | number | null;
  actualHours: string | number | null;
  notes: string | null;
  beforePhotoCount: number;
  afterPhotoCount: number;
  completedAt: string;
}

export async function generateJobCompletionPdf(data: JobPdfData): Promise<string> {
  const pdfsDir = process.env.PDFS_DIR || path.resolve(process.cwd(), "pdfs");
  if (!fs.existsSync(pdfsDir)) {
    fs.mkdirSync(pdfsDir, { recursive: true });
  }

  const filename = `job-${data.jobId}-completion-${Date.now()}.pdf`;
  const filepath = path.join(pdfsDir, filename);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: "LETTER" });
    const stream = fs.createWriteStream(filepath);
    doc.pipe(stream);

    const brand = "#5B9BD5";
    const gray = "#6B7280";
    const dark = "#1A1917";
    const lightGray = "#E5E2DC";

    doc.rect(0, 0, doc.page.width, 80).fill(brand);
    doc.fillColor("#FFFFFF").fontSize(22).font("Helvetica-Bold")
      .text(data.companyName, 50, 25, { width: doc.page.width - 100 });
    doc.fontSize(11).font("Helvetica")
      .text("Job Completion Report", 50, 52, { width: doc.page.width - 100 });

    doc.fillColor(dark).fontSize(20).font("Helvetica-Bold")
      .text(`Job #${data.jobId}`, 50, 110);

    doc.fontSize(10).font("Helvetica").fillColor(gray)
      .text(`Completed: ${data.completedAt}`, 50, 138);

    doc.moveTo(50, 165).lineTo(doc.page.width - 50, 165).strokeColor(lightGray).stroke();

    let y = 185;

    const field = (label: string, value: string | null | undefined, xLeft = 50, xRight = 200) => {
      doc.fontSize(9).font("Helvetica-Bold").fillColor(gray).text(label.toUpperCase(), xLeft, y);
      doc.fontSize(11).font("Helvetica").fillColor(dark).text(value || "—", xRight, y - 1, { width: 220 });
      y += 24;
    };

    doc.fontSize(13).font("Helvetica-Bold").fillColor(brand).text("Client Details", 50, y);
    y += 20;
    field("Client", data.clientName);
    field("Address", data.clientAddress);

    y += 10;
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(lightGray).stroke();
    y += 20;

    doc.fontSize(13).font("Helvetica-Bold").fillColor(brand).text("Job Details", 50, y);
    y += 20;
    field("Service Type", data.serviceType);
    field("Scheduled Date", data.scheduledDate);
    field("Scheduled Time", data.scheduledTime);
    field("Assigned To", data.assignedUserName);
    field("Base Fee", data.baseFee != null ? `$${Number(data.baseFee).toFixed(2)}` : null);
    field("Actual Hours", data.actualHours != null ? `${Number(data.actualHours).toFixed(2)} hrs` : null);

    if (data.notes) {
      y += 10;
      doc.fontSize(9).font("Helvetica-Bold").fillColor(gray).text("NOTES", 50, y);
      y += 14;
      doc.fontSize(10).font("Helvetica").fillColor(dark).text(data.notes, 50, y, { width: doc.page.width - 100 });
      y += doc.heightOfString(data.notes, { width: doc.page.width - 100 }) + 10;
    }

    y += 10;
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(lightGray).stroke();
    y += 20;

    doc.fontSize(13).font("Helvetica-Bold").fillColor(brand).text("Photo Summary", 50, y);
    y += 20;

    const boxW = 120;
    const boxH = 60;
    const boxes = [
      { label: "Before Photos", value: data.beforePhotoCount },
      { label: "After Photos", value: data.afterPhotoCount },
    ];
    boxes.forEach((box, i) => {
      const bx = 50 + i * (boxW + 20);
      doc.rect(bx, y, boxW, boxH).fillColor("#F7F6F3").fill()
        .rect(bx, y, boxW, boxH).strokeColor(lightGray).stroke();
      doc.fontSize(22).font("Helvetica-Bold").fillColor(brand)
        .text(String(box.value), bx, y + 8, { width: boxW, align: "center" });
      doc.fontSize(9).font("Helvetica").fillColor(gray)
        .text(box.label, bx, y + 38, { width: boxW, align: "center" });
    });
    y += boxH + 30;

    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(lightGray).stroke();
    y += 20;

    doc.fontSize(9).fillColor(gray).font("Helvetica")
      .text(
        `This document was generated automatically by Qleno on ${new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}.`,
        50, y, { width: doc.page.width - 100, align: "center" }
      );

    doc.end();

    stream.on("finish", () => resolve(`/api/pdfs/${filename}`));
    stream.on("error", reject);
  });
}
