# Apple design context: RecoverKit dashboard

- Platform: a **web** dashboard (server-rendered HTML, no JavaScript, strict CSP). It is styled after Apple HIG conventions for macOS (desktop) and iOS (phone).
- Users: business owners and developers at Nigerian digital businesses (VTU, fintech, e-commerce). They are often on a phone.
- Navigation: sidebar (source list, at most two levels) at ≥ 820px. Below that, a bottom tab bar with 5 items (Overview, Leads, Messages, Payments, Settings).
- Colors: Apple system colors as CSS tokens (systemBlue accent, systemGreen success, systemRed destructive, systemOrange warning, label/secondaryLabel, grouped backgrounds). Follows the OS light/dark mode, with no in-app theme switch.
- Type: the system font stack (SF Pro on Apple devices). Large titles 34/28px, body 17px on mobile and 15px on desktop, no light weights.
- Components: inset grouped lists for settings, switches only inside list rows, segmented controls for 2–4 related filters, one prominent (filled) button per view, destructive actions never primary, and disclosure (`<details>`) for advanced options.
- Feedback: inline status banners after every action. Empty states always give a next step.
- Accessibility: WCAG AA contrast, 44px touch targets, visible focus rings, information never shown by color alone, and support for reduced motion.
- Brand: no custom brand color beyond the accent. The content is the interface.
