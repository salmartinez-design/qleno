import { useEffect } from 'react';
import { useGetMyCompany } from '@workspace/api-client-react';
import { getAuthHeaders, useAuthStore } from '@/lib/auth';

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

  const brandColor = (company as any)?.brand_color || '#5B9BD5';

  useEffect(() => {
    applyTenantColor(brandColor);
  }, [brandColor]);

  const rawName: string | null =
    (company as any)?.name ?? (company as any)?.company_name ?? null;

  return {
    company,
    isLoading,
    brandColor,
    logoUrl: (company as any)?.logo_url || null,
    companyName: rawName,
  };
}
