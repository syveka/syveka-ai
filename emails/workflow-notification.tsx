import { Body, Container, Head, Html, Preview, Text } from "@react-email/components";

export function WorkflowNotificationEmail({
  body,
  workflowName,
}: {
  body: string;
  workflowName: string;
}) {
  return (
    <Html>
      <Head />
      <Preview>{body.slice(0, 80)}</Preview>
      <Body style={{ backgroundColor: "#f6f8fa", fontFamily: "system-ui, sans-serif" }}>
        <Container style={{ background: "#fff", borderRadius: 8, margin: "40px auto", padding: 32, maxWidth: 520 }}>
          <Text style={{ whiteSpace: "pre-wrap" }}>{body}</Text>
          <Text style={{ color: "#6b7280", fontSize: 12, marginTop: 24 }}>
            Sent by Syveka AI automation “{workflowName}”
          </Text>
        </Container>
      </Body>
    </Html>
  );
}

export default WorkflowNotificationEmail;
