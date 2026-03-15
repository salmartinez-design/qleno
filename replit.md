# CleanOps Pro

## Overview

CleanOps Pro is a multi-tenant SaaS platform designed for residential and commercial cleaning businesses. It aims to be a comprehensive management solution, surpassing existing market offerings like MaidCentral. The platform provides tools for managing jobs, employees, customers, invoicing, payroll, and marketing initiatives such as loyalty programs and discounts. It also features a dedicated client portal and robust reporting capabilities to enhance operational efficiency and business growth. The project's ambition is to empower cleaning businesses with advanced, intuitive technology to streamline their operations and improve client satisfaction.

## User Preferences

I prefer iterative development with clear communication on significant changes. Before making major architectural changes or introducing new dependencies, please ask for approval. Focus on delivering well-tested, modular code.

## System Architecture

CleanOps Pro is built as a pnpm monorepo, separating the API server and the frontend application.

### UI/UX Decisions
- **Theme:** Full light theme with an Apple/Tesla-grade aesthetic.
- **Fonts:** Exclusively Plus Jakarta Sans (all weights).
- **Colors:** A defined palette including `bg-base #F7F6F3`, `bg-card #FFFFFF`, `border #E5E2DC`, `text primary #1A1917`, `text secondary #6B7280`, `muted #9E9B94`. Brand accent uses `--brand` (`#5B9BD5`) and `--brand-foreground` (`#FFFFFF`). The admin portal uses a purple accent (`#7F77DD`) with specific sidebar and main background colors.
- **Design Elements:** No dark backgrounds, subtle box-shadows on cards, and 6px scrollbars.
- **Responsiveness:** Mobile-first design for employee-facing features like `/my-jobs`.

### Technical Implementations
- **Frontend:** React 18 with Vite, styled using Tailwind CSS and `shadcn/ui`. State management is handled by Zustand, and data fetching with TanStack React Query. Routing is managed by Wouter.
- **Backend:** Express 5 handles API requests.
- **Database:** PostgreSQL is used with Drizzle ORM for type-safe database interactions.
- **Validation:** Zod is used for schema validation across the application.
- **API Generation:** Orval generates API clients and Zod schemas from an OpenAPI specification.
- **Authentication:** JWTs are used for both staff and client portal authentication, with bcryptjs for password hashing.
- **Multi-Tenancy:** Critical for the SaaS model, every database table includes a `company_id`, and all API requests are validated against the `company_id` extracted from the JWT.
- **Geo-fencing:** Integrated for employee clock-in/out, verifying location against job sites using Google Maps API.
- **Tenant Branding:** A `useTenantBrand()` hook dynamically applies company-specific branding colors to the UI.
- **PWA Support:** The frontend is configured as a Progressive Web App for improved accessibility and user experience.
- **Global Search:** A unified search functionality `/` to quickly find clients, jobs, employees, and invoices.
- **Team Chat:** A real-time, slide-in chat panel for internal communication with channels and direct messages.
- **Keyboard Shortcuts:** System-wide shortcuts for quick navigation and actions.

### Feature Specifications
- **Dashboard:** Provides an at-a-glance overview of daily operations, revenue, alerts, and employee status.
- **Job Management:** A 3-step wizard for job creation, dispatch, and duplication, supporting various service types.
- **Employee Management:** Detailed employee profiles across 11 tabs covering personal info, skills, attendance, availability, payroll, and performance scorecards. Includes an invite flow for new employees.
- **Customer Management:** Comprehensive client profiles with loyalty points, service history, and communication logs. Features a 13-tab client profile including quotes, payments, and attachments.
- **Invoicing & Billing:** Invoice generation with status tracking, batch invoicing capabilities, and Stripe integration for subscriptions and payments.
- **Agreement Builder:** Native e-signature functionality with pre-seeded templates, customizable policy blocks, and SHA-256 content hashing for compliance.
- **Form Builder:** Drag-and-drop form creation with various field types, embed options, and submission tracking.
- **Notifications:** Customizable notification templates with variable tokens and activity logs.
- **Loyalty & Discounts:** Configurable loyalty programs and discount code management.
- **Payroll:** Tools for payroll export and period management.
- **Client Portal:** A branded portal for clients to view upcoming jobs, history, rate services, and tip technicians.
- **Reporting:** Performance insights, employee alerts, client churn risk, and revenue analytics.

## External Dependencies

- **Stripe:** For subscription management and payment processing (invoicing, charging cards, refunds).
- **Google Maps API:** Used for geocoding client addresses and validating employee locations for geo-fencing.
- **pdfkit:** For generating PDF reports (e.g., job completion reports).
- **Orval:** For API client and schema generation.
- **Zod:** For data validation.
- **Drizzle ORM:** For database interactions with PostgreSQL.
- **bcryptjs & jsonwebtoken:** For secure authentication and authorization.
- **Tailwind CSS & shadcn/ui:** For styling and UI components.
- **TanStack React Query:** For server state management and data fetching.
- **Zustand:** For client-side state management.