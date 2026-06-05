import type { Config } from "tailwindcss";
import typography from "@tailwindcss/typography";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    container: {
      center: true,
      padding: {
        DEFAULT: "1rem",
        md: "1.5rem",
        lg: "2rem",
      },
      screens: {
        "2xl": "1280px",
      },
    },
    extend: {
      colors: {
        // CareerPilot Brand DNA
        primary: {
          DEFAULT: "#003893", // Brand Blue
          50: "#E6ECF7",
          100: "#CCD9EF",
          200: "#99B3DF",
          300: "#668DCF",
          400: "#3367BF",
          500: "#003893",
          600: "#00307A",
          700: "#002862",
          800: "#00204A",
          900: "#001831",
        },
        accent: {
          DEFAULT: "#F5A623", // Accent Amber
          50: "#FFF8ED",
          100: "#FEF0D6",
          200: "#FDE0AC",
          300: "#FCCF83",
          400: "#FBAE59",
          500: "#F5A623",
          600: "#DD8C17",
          700: "#B96F0E",
          800: "#92530A",
          900: "#713D07",
        },
        surface: "#F8F9FA", // Light Surface Gray
        muted: "#626C7A", // Muted Text Gray
        secondary: {
          DEFAULT: "#2D2D2D", // Dark Charcoal
          50: "#F6F6F6",
          100: "#E7E7E7",
          200: "#CFCFCF",
          300: "#B8B8B8",
          400: "#8E8E8E",
          500: "#5A5A5A",
          600: "#404040",
          700: "#2D2D2D",
          800: "#1F1F1F",
          900: "#121212",
        },
        background: "#FFFFFF",
      },
      fontFamily: {
        heading: ["var(--font-heading)", "sans-serif"],
        body: ["var(--font-body)", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px 0 rgb(0 0 0 / 0.04), 0 4px 12px -2px rgb(0 56 147 / 0.08)",
        cardHover: "0 4px 8px -2px rgb(0 0 0 / 0.06), 0 12px 24px -4px rgb(0 56 147 / 0.12)",
      },
      borderRadius: {
        xl: "0.875rem",
        "2xl": "1.125rem",
      },
      animation: {
        "fade-in": "fadeIn 0.3s ease-out",
        "slide-up": "slideUp 0.4s ease-out",
      },
      keyframes: {
        fadeIn: {
          "0%": { opacity: "0" },
          "100%": { opacity: "1" },
        },
        slideUp: {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
    },
  },
  plugins: [typography],
};

export default config;
