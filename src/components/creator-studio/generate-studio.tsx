"use client";

import { useMemo, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import {
  generateCharacterImageAction,
  generateImageFromCharacterAction,
  generateVideoFromImageAction,
  generateCaptionAction,
} from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";

type Profile = { id: string; displayName: string; status: string };
type Template = { id: string; name: string; category: string; aspectRatio: string };
type Asset = { id: string; assetType: string; creatorProfileId: string };

const ASPECT_RATIOS = ["1:1", "4:5", "9:16", "16:9"] as const;
const PLATFORMS = ["INSTAGRAM", "FACEBOOK", "TIKTOK", "YOUTUBE"] as const;
const LANGUAGES = ["EN", "FI", "AR"] as const;
type Mode = "IMAGE" | "IMAGE_TO_VIDEO" | "CAPTION";

export function GenerateStudio({
  profiles,
  templates,
  assets,
  defaultProfileId,
  creditBalance,
  estimatedCosts,
}: {
  profiles: Profile[];
  templates: Template[];
  assets: Asset[];
  defaultProfileId?: string;
  creditBalance: number;
  estimatedCosts: { IMAGE: number; IMAGE_TO_VIDEO: number; CAPTION: number };
}) {
  const t = useTranslations("creatorStudio.create");
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("IMAGE");
  const [profileId, setProfileId] = useState(defaultProfileId ?? profiles[0]?.id ?? "");
  const [templateId, setTemplateId] = useState<string>("");
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<(typeof ASPECT_RATIOS)[number]>("1:1");
  const [sourceAssetId, setSourceAssetId] = useState<string>("");
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>("INSTAGRAM");
  const [language, setLanguage] = useState<(typeof LANGUAGES)[number]>("EN");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{ error?: string; id?: string } | null>(null);

  const activeProfiles = profiles.filter((p) => p.status === "ACTIVE");
  const generatedImages = assets.filter((a) => a.assetType.includes("image"));

  const estimatedCost = useMemo(() => estimatedCosts[mode], [estimatedCosts, mode]);

  const canAfford = creditBalance >= estimatedCost;

  function submit() {
    setResult(null);
    startTransition(async () => {
      if (mode === "IMAGE") {
        const res = templateId
          ? await generateImageFromCharacterAction({
              creatorProfileId: profileId,
              templateId,
              prompt,
              aspectRatio,
            })
          : await generateCharacterImageAction({
              creatorProfileId: profileId,
              prompt,
              aspectRatio,
            });
        setResult(res);
      } else if (mode === "IMAGE_TO_VIDEO") {
        const res = await generateVideoFromImageAction({
          sourceAssetId,
          creatorProfileId: profileId || undefined,
          aspectRatio,
        });
        setResult(res);
      } else {
        const res = await generateCaptionAction({
          platform,
          language,
          creatorProfileId: profileId || undefined,
        });
        setResult(res);
      }
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {(["IMAGE", "IMAGE_TO_VIDEO", "CAPTION"] as Mode[]).map((m) => (
          <Button key={m} variant={mode === m ? "default" : "outline"} onClick={() => setMode(m)}>
            {t(`mode.${m}`)}
          </Button>
        ))}
      </div>

      <Card>
        <CardContent className="space-y-4 py-5">
          {mode !== "CAPTION" || true ? (
            <div>
              <label className="mb-1 block text-sm font-medium">{t("creatorLabel")}</label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
              >
                <option value="">{t("noCreator")}</option>
                {activeProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {mode === "IMAGE" ? (
            <>
              <div>
                <label className="mb-1 block text-sm font-medium">{t("templateLabel")}</label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={templateId}
                  onChange={(e) => setTemplateId(e.target.value)}
                >
                  <option value="">{t("noTemplate")}</option>
                  {templates.map((tpl) => (
                    <option key={tpl.id} value={tpl.id}>
                      {tpl.name} ({tpl.category})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t("promptLabel")}</label>
                <textarea
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t("promptPlaceholder")}
                />
              </div>
            </>
          ) : null}

          {mode === "IMAGE_TO_VIDEO" ? (
            <div>
              <label className="mb-1 block text-sm font-medium">{t("sourceImageLabel")}</label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={sourceAssetId}
                onChange={(e) => setSourceAssetId(e.target.value)}
              >
                <option value="">{t("selectImage")}</option>
                {generatedImages.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.id.slice(0, 8)}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {mode !== "CAPTION" ? (
            <div>
              <label className="mb-1 block text-sm font-medium">{t("aspectRatioLabel")}</label>
              <div className="flex gap-2">
                {ASPECT_RATIOS.map((ar) => (
                  <Button
                    key={ar}
                    type="button"
                    variant={aspectRatio === ar ? "default" : "outline"}
                    onClick={() => setAspectRatio(ar)}
                  >
                    {ar}
                  </Button>
                ))}
              </div>
            </div>
          ) : null}

          {mode === "CAPTION" ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-sm font-medium">{t("platformLabel")}</label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={platform}
                  onChange={(e) => setPlatform(e.target.value as (typeof PLATFORMS)[number])}
                >
                  {PLATFORMS.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t("languageLabel")}</label>
                <select
                  className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                  value={language}
                  onChange={(e) => setLanguage(e.target.value as (typeof LANGUAGES)[number])}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ) : null}

          <div className="flex items-center justify-between border-t pt-4">
            <p className="text-sm text-muted-foreground">
              {t("estimatedCost", { cost: estimatedCost })}
              {!canAfford ? (
                <span className="ms-2 text-destructive">{t("insufficientCredits")}</span>
              ) : null}
            </p>
            <Button
              onClick={submit}
              disabled={
                pending ||
                !canAfford ||
                (mode === "IMAGE" && (!profileId || !prompt.trim())) ||
                (mode === "IMAGE_TO_VIDEO" && !sourceAssetId)
              }
            >
              {pending ? t("generating") : t("generateCta")}
            </Button>
          </div>

          {result?.error ? <p className="text-sm text-destructive">{result.error}</p> : null}
          {result?.id ? <p className="text-sm text-success">{t("generationQueued")}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
