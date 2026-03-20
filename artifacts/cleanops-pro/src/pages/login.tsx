import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { useLogin } from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";
import { QlenoLogo } from "@/components/brand/QlenoLogo";

const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(8, "Password must be at least 8 characters"),
});

type LoginFormValues = z.infer<typeof loginSchema>;

export default function Login() {
  const [, setLocation] = useLocation();
  const token = useAuthStore(state => state.token);
  const setToken = useAuthStore(state => state.setToken);
  const { toast } = useToast();

  useEffect(() => {
    document.title = "Login — Qleno";
  }, []);

  useEffect(() => {
    if (token) {
      try {
        const payload = JSON.parse(atob(token.split('.')[1]));
        if (payload.role === 'super_admin') {
          setLocation("/admin");
        } else {
          setLocation("/dashboard");
        }
      } catch {
        setLocation("/dashboard");
      }
    }
  }, [token, setLocation]);

  const { register, handleSubmit, formState: { errors } } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" }
  });

  const loginMutation = useLogin();

  const onSubmit = (data: LoginFormValues) => {
    loginMutation.mutate(
      { data },
      {
        onSuccess: (res) => {
          setToken(res.token);
          toast({ title: "Welcome back", description: `Logged in as ${res.user.first_name}` });
          if (res.user.role === 'super_admin') {
            setLocation("/admin");
          } else {
            setLocation("/dashboard");
          }
        },
        onError: () => {
          toast({ variant: "destructive", title: "Login Failed", description: "Invalid email or password" });
        }
      }
    );
  };

  const INP: React.CSSProperties = {
    width: '100%', height: '44px',
    backgroundColor: '#F7F6F3', border: '1px solid #DEDAD4',
    borderRadius: '8px', color: '#1A1917',
    fontSize: '13px', padding: '0 14px', outline: 'none',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    transition: 'border-color 0.15s',
  };

  return (
    <div style={{
      minHeight: '100vh', width: '100%',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      backgroundColor: '#F3F3F0', padding: '16px',
      fontFamily: "'Plus Jakarta Sans', sans-serif",
    }}>
      <div style={{ position: 'relative', width: '100%', maxWidth: '400px', backgroundColor: '#FFFFFF', border: '1px solid #E5E2DC', borderRadius: '16px', padding: '40px 36px', boxShadow: '0 4px 24px rgba(0,0,0,0.06)' }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <div style={{ display: 'flex', justifyContent: 'center', marginBottom: '16px' }}>
            <QlenoLogo size="lg" theme="light" layout="stacked" />
          </div>
          <p style={{
            fontSize: '13px', color: '#6B6860', margin: 0,
            letterSpacing: '0.04em', fontFamily: "'Plus Jakarta Sans', sans-serif",
          }}>
            Cleaning operations software
          </p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: '6px' }}>Email Address</label>
            <input
              type="email"
              placeholder="you@yourcompany.com"
              style={INP}
              onFocus={e => (e.target.style.borderColor = '#00C9A0')}
              onBlur={e => (e.target.style.borderColor = '#DEDAD4')}
              {...register("email")}
            />
            {errors.email && <p style={{ fontSize: '11px', color: '#DC2626', marginTop: '4px' }}>{errors.email.message}</p>}
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <label style={{ fontSize: '11px', fontWeight: 600, color: '#9E9B94', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Password</label>
              <a href="#" style={{ fontSize: '12px', color: '#00C9A0', textDecoration: 'none' }}>Forgot password?</a>
            </div>
            <input
              type="password"
              placeholder="••••••••"
              style={INP}
              onFocus={e => (e.target.style.borderColor = '#00C9A0')}
              onBlur={e => (e.target.style.borderColor = '#DEDAD4')}
              {...register("password")}
            />
            {errors.password && <p style={{ fontSize: '11px', color: '#DC2626', marginTop: '4px' }}>{errors.password.message}</p>}
          </div>

          <button
            type="submit"
            disabled={loginMutation.isPending}
            style={{
              width: '100%', height: '44px',
              backgroundColor: '#0A0E1A', color: '#FFFFFF',
              borderRadius: '8px', fontSize: '14px', fontWeight: 600,
              border: 'none', cursor: loginMutation.isPending ? 'wait' : 'pointer',
              opacity: loginMutation.isPending ? 0.7 : 1, marginTop: '6px',
              fontFamily: "'Plus Jakarta Sans', sans-serif",
              transition: 'opacity 0.15s',
            }}
          >
            {loginMutation.isPending ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
