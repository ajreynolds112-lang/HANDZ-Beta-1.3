import type { ReactNode } from "react";
import { SignIn, SignUp } from "@clerk/react";
import { Link } from "wouter";
import { clerkAppearance } from "./clerkAppearance";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden bg-[#101110] px-4 py-12 text-[#eee9df]">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 opacity-40" style={{ backgroundImage: "linear-gradient(120deg, transparent 0 48%, rgba(205,156,65,.12) 48.1%, transparent 48.4%), repeating-linear-gradient(0deg, transparent 0 46px, rgba(255,255,255,.025) 47px 48px)" }} />
      <div className="relative z-10 w-full max-w-[440px]">
        <Link href="/" className="mb-7 flex items-center justify-center gap-3 text-[#d9a441] transition-colors hover:text-[#f1c96e] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d9a441]">
          <img src={`${basePath}/logo.svg`} alt="HANDZ" className="h-10 w-auto" />
          <span className="sr-only">Back to HANDZ</span>
        </Link>
        {children}
        <Link href="/" className="mt-6 block text-center text-xs font-bold uppercase tracking-[0.18em] text-[#8d897e] transition-colors hover:text-[#e0b252] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d9a441]">
          Back to the game
        </Link>
      </div>
    </main>
  );
}

export function SignInPage() {
  return (
    <AuthFrame>
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        forceRedirectUrl="/play"
        appearance={clerkAppearance}
      />
    </AuthFrame>
  );
}

export function SignUpPage() {
  return (
    <AuthFrame>
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        forceRedirectUrl="/play"
        appearance={clerkAppearance}
      />
    </AuthFrame>
  );
}
