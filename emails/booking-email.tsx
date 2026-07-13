import { Body, Button, Container, Head, Html, Preview, Text } from "@react-email/components";

/**
 * Localized booking lifecycle email (confirmation / reschedule / cancellation
 * / reminder). Kept as one parameterized template so guest-locale rendering
 * stays in sync across the four flows.
 */

export type BookingEmailKind = "confirmation" | "reschedule" | "cancellation" | "reminder";
export type BookingEmailLocale = "en" | "fi" | "ar";

const STRINGS: Record<
  BookingEmailLocale,
  Record<BookingEmailKind, { heading: string; intro: string }> & {
    when: string;
    where: string;
    manage: string;
    footer: string;
  }
> = {
  en: {
    confirmation: { heading: "Booking confirmed", intro: "Your meeting is booked." },
    reschedule: { heading: "Booking rescheduled", intro: "Your meeting has a new time." },
    cancellation: { heading: "Booking canceled", intro: "Your meeting was canceled." },
    reminder: { heading: "Meeting reminder", intro: "Your meeting is coming up." },
    when: "When",
    where: "Where",
    manage: "Manage booking",
    footer: "Sent by Syveka AI on behalf of",
  },
  fi: {
    confirmation: { heading: "Varaus vahvistettu", intro: "Tapaamisesi on varattu." },
    reschedule: { heading: "Varaus siirretty", intro: "Tapaamisellasi on uusi aika." },
    cancellation: { heading: "Varaus peruttu", intro: "Tapaamisesi on peruttu." },
    reminder: { heading: "Muistutus tapaamisesta", intro: "Tapaamisesi lähestyy." },
    when: "Aika",
    where: "Paikka",
    manage: "Hallitse varausta",
    footer: "Lähettänyt Syveka AI, toimeksiantaja",
  },
  ar: {
    confirmation: { heading: "تم تأكيد الحجز", intro: "تم حجز اجتماعك." },
    reschedule: { heading: "تمت إعادة جدولة الحجز", intro: "لاجتماعك موعد جديد." },
    cancellation: { heading: "تم إلغاء الحجز", intro: "تم إلغاء اجتماعك." },
    reminder: { heading: "تذكير بالاجتماع", intro: "اجتماعك يقترب." },
    when: "الوقت",
    where: "المكان",
    manage: "إدارة الحجز",
    footer: "أُرسل بواسطة Syveka AI بالنيابة عن",
  },
};

export function bookingEmailSubject(
  kind: BookingEmailKind,
  locale: BookingEmailLocale,
  title: string,
): string {
  return `${STRINGS[locale][kind].heading}: ${title}`;
}

export function BookingEmail({
  kind,
  locale = "en",
  title,
  organizationName,
  whenText,
  whereText,
  manageUrl,
  message,
}: {
  kind: BookingEmailKind;
  locale?: BookingEmailLocale;
  title: string;
  organizationName: string;
  whenText: string;
  whereText?: string;
  manageUrl?: string;
  message?: string;
}) {
  const t = STRINGS[locale];
  const dir = locale === "ar" ? "rtl" : "ltr";
  return (
    <Html dir={dir} lang={locale}>
      <Head />
      <Preview>{`${t[kind].heading} — ${title}`}</Preview>
      <Body style={{ backgroundColor: "#f6f8fa", fontFamily: "system-ui, sans-serif" }}>
        <Container
          style={{
            background: "#fff",
            borderRadius: 8,
            margin: "40px auto",
            padding: 32,
            maxWidth: 520,
            direction: dir,
            textAlign: locale === "ar" ? ("right" as const) : ("left" as const),
          }}
        >
          <Text style={{ fontSize: 20, fontWeight: 600 }}>{t[kind].heading}</Text>
          <Text>{t[kind].intro}</Text>
          <Text style={{ fontWeight: 600, marginBottom: 4 }}>{title}</Text>
          <Text style={{ margin: "4px 0" }}>
            {t.when}: {whenText}
          </Text>
          {whereText ? (
            <Text style={{ margin: "4px 0" }}>
              {t.where}: {whereText}
            </Text>
          ) : null}
          {message ? <Text style={{ whiteSpace: "pre-wrap" }}>{message}</Text> : null}
          {manageUrl ? (
            <Button
              href={manageUrl}
              style={{
                background: "#6366f1",
                borderRadius: 6,
                color: "#fff",
                display: "inline-block",
                marginTop: 16,
                padding: "10px 18px",
              }}
            >
              {t.manage}
            </Button>
          ) : null}
          <Text style={{ color: "#6b7280", fontSize: 12, marginTop: 24 }}>
            {t.footer} {organizationName}
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default BookingEmail;
