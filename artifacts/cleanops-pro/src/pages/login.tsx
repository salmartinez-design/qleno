import { useEffect } from "react";
import { useLocation } from "wouter";
import { useAuthStore } from "@/lib/auth";
import { useLogin } from "@workspace/api-client-react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useToast } from "@/hooks/use-toast";

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

  // If already logged in, go to correct portal
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

  const F: React.CSSProperties = {
    width: '100%', height: '44px',
    backgroundColor: '#1A1A1A', border: '1px solid #2A2A2A',
    borderRadius: '8px', color: '#F0EDE8',
    fontSize: '13px', padding: '0 14px', outline: 'none',
  };

  return (
    <div style={{ minHeight: '100vh', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0A0A0A', padding: '16px' }}>
      {/* Glow blobs */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', top: '-20%', right: '-10%', width: '50%', height: '50%', borderRadius: '50%', background: 'rgba(197,48,48,0.12)', filter: 'blur(120px)' }} />
        <div style={{ position: 'absolute', bottom: '-20%', left: '-10%', width: '40%', height: '40%', borderRadius: '50%', background: 'rgba(197,48,48,0.06)', filter: 'blur(80px)' }} />
      </div>

      <div style={{ position: 'relative', width: '100%', maxWidth: '420px', backgroundColor: '#161616', border: '1px solid #222222', borderRadius: '16px', padding: '36px 32px' }}>
        {/* Brand */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <div style={{ backgroundColor: '#FFFFFF', borderRadius: '10px', padding: '8px 14px', marginBottom: '18px', display: 'inline-block' }}>
            <img src="/phes-logo.jpeg" alt="PHES Cleaning LLC" style={{ height: '48px', width: 'auto', objectFit: 'contain', display: 'block' }} />
          </div>
          <h1 style={{ fontSize: '22px', fontWeight: 700, color: '#F0EDE8', margin: '0 0 6px 0', letterSpacing: '-0.02em' }}>CleanOps Pro</h1>
          <p style={{ fontSize: '13px', color: '#7A7873', margin: 0 }}>Sign in to your workspace</p>
        </div>

        <form onSubmit={handleSubmit(onSubmit)} style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
          <div>
            <label style={{ fontSize: '11px', fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.06em', display: 'block', marginBottom: '6px' }}>Email Address</label>
            <input type="email" placeholder="owner@phescleaning.com" style={F} {...register("email")} />
            {errors.email && <p style={{ fontSize: '11px', color: '#F87171', marginTop: '4px' }}>{errors.email.message}</p>}
          </div>

          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
              <label style={{ fontSize: '11px', fontWeight: 500, color: '#4A4845', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Password</label>
              <a href="#" style={{ fontSize: '12px', color: 'var(--brand)', textDecoration: 'none' }}>Forgot password?</a>
            </div>
            <input type="password" placeholder="••••••••" style={F} {...register("password")} />
            {errors.password && <p style={{ fontSize: '11px', color: '#F87171', marginTop: '4px' }}>{errors.password.message}</p>}
          </div>

          <button
            type="submit"
            disabled={loginMutation.isPending}
            style={{ width: '100%', height: '44px', backgroundColor: 'var(--brand)', color: '#0A0A0A', borderRadius: '8px', fontSize: '15px', fontWeight: 600, border: 'none', cursor: loginMutation.isPending ? 'wait' : 'pointer', opacity: loginMutation.isPending ? 0.7 : 1, marginTop: '4px' }}
          >
            {loginMutation.isPending ? "Signing in..." : "Sign In"}
          </button>
        </form>
      </div>
    </div>
  );
}
