Qleno LMS module screenshots.

STATUS (2026-07-15): the four PNGs here are HIGH-FIDELITY RECREATIONS of the
real Qleno technician screens (layout, labels, and states were reproduced
from the live tech app — My Jobs day view, arrival Clock In + Check In, the
in-range GPS check, and the Clock/Job Change Request form). All data is
de-identified sample data ("Jamie Carter", a sample address/phone), and each
carries a small "SAMPLE — recreated Qleno tech screen with de-identified
data" band. They are NOT literal screen captures.

Why recreations instead of literal captures: a literal screenshot of the
live app is backed by production data (real client name, address, phone) that
must not appear in an all-employee handbook, and the browser used for capture
runs on a different machine than this repo. If you ever want a literal
capture, export a de-identified PNG from the tech app and drop it here with
the SAME filename below — no code change needed.

Drop the de-identified PNGs here using these exact filenames (referenced by
the "image" blocks in the Qleno training module in
artifacts/qleno/src/lib/training/curriculum.ts):

  qleno-day-view.png        — the tech's daily job list
  qleno-clock-in.png        — Clock In / Check In at arrival
  qleno-gps-checkin.png     — GPS check-in (in-range state)
  qleno-time-correction.png — Clock/Job Change Request form

Match the existing guide-asset convention (public/guides/<topic>/*.png).
