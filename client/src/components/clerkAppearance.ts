import { dark } from "@clerk/themes";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export const clerkAppearance = {
  theme: dark,
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: "#d9a441",
    colorForeground: "#f2eee5",
    colorMutedForeground: "#a29b8e",
    colorDanger: "#ef6657",
    colorBackground: "#171817",
    colorInput: "#20211f",
    colorInputForeground: "#f2eee5",
    colorNeutral: "#45443f",
    fontFamily: "'Oxanium', sans-serif",
    borderRadius: "0.65rem",
  },
  elements: {
    rootBox: { width: "100%", display: "flex", justifyContent: "center" },
    cardBox: { backgroundColor: "#171817", borderRadius: "14px", width: "440px", maxWidth: "100%", overflow: "hidden", border: "1px solid #383832" },
    card: { boxShadow: "none", border: "0", background: "transparent", borderRadius: "0" },
    footer: { boxShadow: "none", border: "0", background: "transparent", borderRadius: "0" },
    headerTitle: { color: "#f2eee5", fontFamily: "'Oxanium', sans-serif", letterSpacing: "0.04em" },
    headerSubtitle: { color: "#aaa397" },
    socialButtonsBlockButtonText: { color: "#f2eee5", fontWeight: "600" },
    formFieldLabel: { color: "#d5cfc4", fontWeight: "600" },
    footerActionLink: { color: "#e2b657", fontWeight: "700" },
    footerActionText: { color: "#b6afa3" },
    dividerText: { color: "#aaa397" },
    identityPreviewEditButton: { color: "#e2b657" },
    formFieldSuccessText: { color: "#9acb92" },
    alertText: { color: "#ffd0c8" },
    logoBox: { marginBottom: "12px" },
    logoImage: { maxHeight: "48px" },
    socialButtonsBlockButton: { background: "#222320", border: "1px solid #48473f", color: "#f2eee5" },
    formButtonPrimary: { background: "#c58c2d", color: "#191814", fontWeight: "800", letterSpacing: "0.04em" },
    formFieldInput: { background: "#20211f", border: "1px solid #4b4941", color: "#f2eee5" },
    footerAction: { background: "transparent" },
    dividerLine: { background: "#44423c" },
    alert: { background: "#3a211e", border: "1px solid #8e4b3e" },
    otpCodeFieldInput: { background: "#20211f", border: "1px solid #4b4941", color: "#f2eee5" },
    formFieldRow: { marginBottom: "16px" },
    main: { color: "#f2eee5" },
  },
};

export const clerkLocalization = {
  signIn: {
    start: {
      title: "Back in the ring",
      subtitle: "Sign in to pick up your career.",
    },
  },
  signUp: {
    start: {
      title: "Make your corner",
      subtitle: "Create an account to keep your career close.",
    },
  },
};
