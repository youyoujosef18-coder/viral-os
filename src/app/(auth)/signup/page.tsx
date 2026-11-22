import { Suspense } from "react";
import { AuthForm, AuthFrame } from "../auth-form";

export const metadata = { title: "Create account" };

export default function SignupPage() {
  return (
    <AuthFrame title="Create your workspace">
      <Suspense>
        <AuthForm mode="signup" />
      </Suspense>
    </AuthFrame>
  );
}
