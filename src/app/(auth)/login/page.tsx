import { Suspense } from "react";
import { AuthForm, AuthFrame } from "../auth-form";

export const metadata = { title: "Sign in" };

export default function LoginPage() {
  return (
    <AuthFrame title="Sign in">
      <Suspense>
        <AuthForm mode="login" />
      </Suspense>
    </AuthFrame>
  );
}
