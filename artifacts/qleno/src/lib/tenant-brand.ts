import { useEffect } from 'react';
import { useGetMyCompany } from '@workspace/api-client-react';
import { getAuthHeaders, useAuthStore } from '@/lib/auth';
import { setCompanyTimeZone } from '@/lib/company-tz';

function hexToRgb(hex: string): string {
  const cleaned = hex.replace('#', '');
  const r = parseInt(cleaned.substring(0, 2), 16);
  const g = parseInt(cleaned.substring(2, 4), 16);
  const b = parseInt(cleaned.substring(4, 6), 16);
  return `${r}, ${g}, ${b}`;
}

export function applyTenantColor(hex: string) {
  const rgb = hexToRgb(hex);
  const el = document.documentElement;
  el.style.setProperty('--brand', hex);
  el.style.setProperty('--brand-rgb', rgb);
  el.style.setProperty('--brand-dim', `rgba(${rgb}, 0.15)`);
  el.style.setProperty('--brand-soft', `rgba(${rgb}, 0.08)`);
  // Legacy aliases for any remaining references
  el.style.setProperty('--tenant-color', hex);
  el.style.setProperty('--tenant-color-rgb', rgb);
}

export function useTenantBrand() {
  const token = useAuthStore(state => state.token);

  const { data: company, isLoading } = useGetMyCompany({
    request: { headers: getAuthHeaders() },
    query: {
      queryKey: ['/api/companies/me', token ?? ''],
      enabled: !!token,
      retry: 1,
      staleTime: 60_000,
    }
  });

  // [brand 2026-07-22] Falls back to Electric Mint, matching the :root default
  // in index.css. It used to fall back to a blue, so any tenant with a null
  // brand_color — and every render before /companies/me resolves — painted the
  // app someone else's color for a beat.
  const brandColor = (company as any)?.brand_color || '#00C9A0';

  useEffect(() => {
    applyTenantColor(brandColor);
  }, [brandColor]);

  // [company-timezone 2026-08-15] This fetch is already the app's one read of
  // /api/companies/me, so it's also where the tenant's zone lands. Everything
  // date-formatting in the app reads it through `companyTz()`; until this
  // resolves (and for a company with no zone set) that stays Central, which is
  // exactly the behavior the hardcoded literals had.
  const companyTimezone: string | null = (company as any)?.timezone ?? null;
  useEffect(() => {
    setCompanyTimeZone(companyTimezone);
  }, [companyTimezone]);

  const rawName: string | null =
    (company as any)?.name ?? (company as any)?.company_name ?? null;

  return {
    company,
    isLoading,
    brandColor,
    logoUrl: (company as any)?.logo_url || null,
    timezone: companyTimezone,
    companyName: rawName,
  };
}
