import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  Text,
} from "@react-email/components";

type Props = { orgName: string; inviteUrl: string; locale: "FI" | "EN" | "AR" };

const COPY = {
  FI: {
    preview: (org: string) => `Kutsu: liity organisaatioon ${org}`,
    heading: (org: string) => `Sinut on kutsuttu: ${org}`,
    body: "Hyväksy kutsu alla olevasta painikkeesta. Kutsu on voimassa 7 päivää.",
    cta: "Hyväksy kutsu",
  },
  EN: {
    preview: (org: string) => `You've been invited to ${org}`,
    heading: (org: string) => `You've been invited to ${org}`,
    body: "Accept the invitation with the button below. The invite expires in 7 days.",
    cta: "Accept invitation",
  },
  AR: {
    preview: (org: string) => `تمت دعوتك للانضمام إلى ${org}`,
    heading: (org: string) => `تمت دعوتك للانضمام إلى ${org}`,
    body: "اقبل الدعوة عبر الزر أدناه. تنتهي صلاحية الدعوة خلال ٧ أيام.",
    cta: "قبول الدعوة",
  },
} as const;

export function InvitationEmail({ orgName, inviteUrl, locale }: Props) {
  const c = COPY[locale];
  return (
    <Html dir={locale === "AR" ? "rtl" : "ltr"}>
      <Head />
      <Preview>{c.preview(orgName)}</Preview>
      <Body style={{ backgroundColor: "#f6f8fa", fontFamily: "system-ui, sans-serif" }}>
        <Container
          style={{
            background: "#fff",
            borderRadius: 8,
            margin: "40px auto",
            padding: 32,
            maxWidth: 480,
          }}
        >
          <Heading as="h2">{c.heading(orgName)}</Heading>
          <Text>{c.body}</Text>
          <Button
            href={inviteUrl}
            style={{ background: "#1d4ed8", borderRadius: 6, color: "#fff", padding: "12px 20px" }}
          >
            {c.cta}
          </Button>
          <Text style={{ color: "#6b7280", fontSize: 12, marginTop: 24 }}>
            Syveka AI · syveka.ai
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default InvitationEmail;
