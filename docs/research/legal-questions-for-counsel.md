# Open legal questions for counsel

For Syveka's legal counsel. These came from an engineering review of 2026-11-05, and engineering has no
view on the answers. The evidence is in
[video-licensing-review.md](video-licensing-review.md). Voice and disclosure questions are in draft PR
#397, and aren't repeated here.

**None of this software is in production.** Creator Studio's existing fal integration is, so questions
1–4 apply today, whatever happens to the pilot.

## fal and Kling (affects current Creator Studio)

1. **Who owns Kling output generated through fal?** fal's terms have no clause assigning Output Content.
   Can Syveka's customers publish it commercially?
2. **Is a multi-tenant SaaS allowed?** §4(b) permits End Users through a Customer Solution, while other
   clauses bar a "service bureau" arrangement and providing the Services "for the benefit of any third
   party". Which governs? Is written authorisation needed under the clause on integrating software?
3. **Do Kling or Kuaishou's own terms bind Syveka,** and which version? fal says models "may be subject
   to additional terms" and names none. Kling's terms couldn't be read.
4. **What must Syveka's customer terms say?** fal requires "legally enforceable agreements" with end
   users, with Syveka indemnifying fal for them. Do current terms meet this, including the likeness and
   deepfake rules? Is fal's cross-referencing in the API terms even pointing to the public terms?

## H.264

5. **Is commercial SaaS H.264 encoding subject to AVC pool licensing,** with any encoder? Does it depend
   on volume or on who receives the file? Current Via LA terms weren't read.

## FFmpeg (GPLv3 build)

6. **What counts as conveying?** Is pushing the image to a private registry, a cloud host, or a contractor's
   system conveying under GPLv3? Do the provisions for contractors working solely for us apply?
7. **If it does count,** is relying on BtbN's public release enough for Corresponding Source, given that
   its retention isn't guaranteed?
8. **Would buying x264's commercial licence** be preferable to a GPL build?

## HyperFrames and bundled code

9. **Are Apache-2.0 and MIT notices owed** for code redistributed in the image, when the `hyperframes`
   package itself ships no notice file? Engineering proposes to include them regardless.
10. **Is there any issue relying on Apache-2.0** when the published `hyperframes` tarball has no LICENSE
    file, given that its `package.json` and repository both state it?

## Chrome for Testing

11. **Does redistributing Chrome for Testing in a container image require anything beyond its notices?**
    Its `ABOUT` file points to the Chrome terms, and no official statement on images was found.

## GSAP (only if ever used)

12. **Does the licence's end-user fee sentence apply** if GSAP ever runs in server-side renders for paying
    customers? The page also says GSAP is free for everyone. Not used today, and engineering's plan is to
    keep it that way.

## Fonts

13. **Does OFL-1.1 raise any issue with video output,** or with fonts inside a container image? Reserved Font
    Names weren't checked.

## Suggested order

Questions 1–4 first, since they apply to the live product. Then 5, which could affect the economics of
all video. The rest only matter before production or distribution of the worker.
