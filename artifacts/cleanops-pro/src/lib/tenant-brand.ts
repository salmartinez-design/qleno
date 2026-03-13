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

  const { data: company } = useGetMyCompany({
    request: { headers: getAuthHeaders() },
    query: { enabled: !!token, retry: false, staleTime: 60_000 }
  });

  useEffect(() => {
    const color = (company as any)?.brand_color || '#C53030';
    applyTenantColor(color);
  }, [(company as any)?.brand_color]);

  return {
    company,
    brandColor: (company as any)?.brand_color || '#C53030',
    logoUrl: (company as any)?.logo_url || null,
    companyName: company?.name || 'CleanOps Pro',
  };
}
