// Syveka Studio (the repo's "Creator Studio": image → video → caption → approval → schedule → publish).
// The feature exists but is off by default and enabled per organisation, so the ads invite people to
// ask about early access rather than presenting it as open to everyone. Contact: syveka.com (supplied).
const CTA_EARLY = T('Kysy ennakkokäytöstä', 'Ask about early access', 'اسأل عن الوصول المبكر');
const ST = { kind: 'studio', bug: 'SYVEKA STUDIO', contact: 'syveka.com', cta: CTA_EARLY };
Object.assign(ADS, {
  ST01: Object.assign({
    title: T('Studio: ideasta julkaisuksi', 'Studio: from idea to post', 'ستوديو: من الفكرة إلى المنشور'), music: 'bright',
    tagline: T('Sisältöä yrityksellesi – ideasta julkaisuun.', 'Content for your business — from idea to post.', 'محتوى لشركتك — من الفكرة إلى النشر.'),
    scenes: [
      { t: 'setpiece', d: 4.4, sub: T('Ideasta julkaisuksi. Yhdessä paikassa.', 'From idea to post. In one place.', 'من الفكرة إلى المنشور. في مكان واحد.'), p: { icon: 'play', bg: 'night', hook: T('Ideasta julkaisuksi.\n*Yhdessä paikassa.*', 'From idea to post.\n*In one place.*', 'من الفكرة إلى المنشور.\n*في مكان واحد.*') } },
      { t: 'sectors', d: 5.6, tr: 'up', cap: T('Kuva, video, teksti, hyväksyntä ja julkaisu samassa työnkulussa.', 'Image, video, caption, approval and publishing in one workflow.', 'صورة، فيديو، نص، موافقة، ونشر — في مسار واحد.'), p: { kicker: 'Syveka Studio', items: [['sparkle', T('Kuva', 'Image', 'صورة')], ['play', T('Video', 'Video', 'فيديو')], ['note', T('Kuvateksti', 'Caption', 'نص مرافق')], ['check', T('Hyväksyntä', 'Approval', 'موافقة')], ['cal', T('Ajastus ja julkaisu', 'Schedule and publish', 'جدولة ونشر')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05', 'tick@1.4', 'tick@1.75'] },
      { t: 'postCard', d: 5.6, tr: 'zoom', concept: true, cap: T('Tekoäly luo luonnoksen. Sinä viimeistelet ja hyväksyt.', 'AI creates the draft. You refine and approve it.', 'الذكاء الاصطناعي يُعدّ المسودة. وأنت تنقّحها وتوافق عليها.'), p: { name: T('Yrityksesi', 'Your business', 'شركتك'), caption: T('Kevään uutuudet ovat täällä. Tule tutustumaan!', 'Our spring arrivals are here. Come and take a look!', 'وصلت تشكيلة الربيع الجديدة. تفضّلوا بزيارتنا!'), draft: T('Luonnos', 'Draft', 'مسودة'), approved: T('Hyväksytty', 'Approved', 'تمت الموافقة') }, sfx: ['rise@0.3', 'type@2.1', 'chime@3.9'] },
      { t: 'weekView', d: 5.0, tr: 'side', concept: true, cap: T('Ajasta julkaisut koko viikolle.', 'Schedule posts for the whole week.', 'جدوِل منشورات الأسبوع كله.'), p: Object.assign({ events: EV(T('Julkaisu', 'Post', 'منشور'), T('Video', 'Video', 'فيديو')) }, WEEK), sfx: ['pop@0.7', 'pop@1.0', 'pop@1.3', 'pop@1.6'] },
      { t: 'end', d: 5.0, tr: 'fade' },
    ],
  }, ST),
  ST02: Object.assign({
    title: T('Studio: sinä hyväksyt', 'Studio: you approve', 'ستوديو: الموافقة لك'), music: 'luxe',
    tagline: T('Sinä päätät, mitä julkaistaan.', 'You decide what gets published.', 'أنت تقرّر ما يُنشَر.'),
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Tekoäly luo. Sinä hyväksyt.', 'AI creates. You approve.', 'الذكاء الاصطناعي يُنشئ. وأنت توافق.'), p: { icon: 'shield', bg: 'ink', hook: T('Tekoäly luo.\n*Sinä hyväksyt.*', 'AI creates.\n*You approve.*', 'الذكاء الاصطناعي يُنشئ.\n*وأنت توافق.*') } },
      { t: 'rowsCard', d: 5.6, tr: 'up', concept: true, cap: T('Näet jokaisen julkaisun ennen kuin se lähtee.', 'You see every post before it goes out.', 'ترى كل منشور قبل أن يخرج.'), p: { bg: 'blue', icon: 'play', title: T('Julkaisu odottaa', 'Post waiting', 'منشور بانتظارك'), tag: PENDING, rows: [[T('Kanava', 'Channel', 'القناة'), 'Instagram'], [T('Ajankohta', 'Time', 'الموعد'), T('To 18:00', 'Thu 18:00', 'الخميس 18:00')], [T('Kuvateksti', 'Caption', 'النص المرافق'), T('Valmis', 'Ready', 'جاهز')]], btn: T('Hyväksy', 'Approve', 'موافقة'), done: T('Ajastettu', 'Scheduled', 'تمت الجدولة') }, sfx: ['pop@2.9', 'chime@3.2'] },
      { t: 'sectors', d: 5.2, tr: 'side', cap: T('Valitse, kuinka paljon tekoäly saa tehdä itse.', 'Choose how much the AI may do on its own.', 'اختر كم يُسمح للذكاء الاصطناعي أن ينفّذ بنفسه.'), p: { kicker: T('Hyväksyntätavat', 'Approval modes', 'أنماط الموافقة'), items: [['user', T('Manuaalinen', 'Manual', 'يدوي')], ['check', T('Hyväksyntä ensin', 'Approval first', 'الموافقة أولاً')], ['bolt', T('Autopilotti säännöillä', 'Autopilot with rules', 'تلقائي وفق قواعد')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05'] },
      { t: 'statement', d: 4.0, tr: 'fade', sub: T('Brändisi. Sinun ehdoillasi.', 'Your brand. On your terms.', 'علامتك. بشروطك.'), p: { bg: 'ink', icon: 'shield', top: 820, text: T('Brändisi.\n*Sinun ehdoillasi.*', 'Your brand.\n*On your terms.*', 'علامتك.\n*بشروطك.*') } },
      { t: 'end', d: 5.0, tr: 'fade' },
    ],
  }, ST),
  ST03: Object.assign({
    title: T('Studio: some kolmella kielellä', 'Studio: social in three languages', 'ستوديو: محتوى بثلاث لغات'), music: 'drive',
    tagline: T('Sisältöstudio yrityksellesi.', 'A content studio for your business.', 'استوديو محتوى لشركتك.'),
    scenes: [
      { t: 'montage', d: 5.0, sub: T('Kuvat. Videot. Tekstit. Some.', 'Images. Videos. Captions. Social.', 'صور. فيديوهات. نصوص. تواصل اجتماعي.'), p: { words: [['sparkle', T('Kuvat', 'Images', 'صور')], ['play', T('Videot', 'Videos', 'فيديوهات')], ['note', T('Tekstit', 'Captions', 'نصوص')], ['globe', T('Some', 'Social', 'تواصل')]] }, sfx: ['hit@0', 'hit@1.25', 'hit@2.5', 'hit@3.75'] },
      { t: 'triLang', d: 6.0, tr: 'zoom', concept: true, cap: T('Kuvatekstit suomeksi, englanniksi ja arabiaksi.', 'Captions in Finnish, English and Arabic.', 'نصوص مرافقة بالفنلندية والإنجليزية والعربية.'), p: { q: T('Kevään uutuudet ovat täällä.', 'Our spring arrivals are here.', 'وصلت تشكيلة الربيع الجديدة.'), a: T('Kuvateksti suomeksi', 'Caption in English', 'نص مرافق بالعربية') }, sfx: ['pop@0.3', 'pop@1.1', 'pop@1.9'] },
      { t: 'sectors', d: 5.0, tr: 'side', cap: T('Julkaise Instagramiin ja Facebookiin – heti tai ajastettuna.', 'Publish to Instagram and Facebook — now or on a schedule.', 'انشر على إنستغرام وفيسبوك — فوراً أو بموعد محدد.'), p: { kicker: T('Julkaisu', 'Publishing', 'النشر'), items: [['play', 'Instagram'], ['users', 'Facebook'], ['cal', T('Ajastettu julkaisu', 'Scheduled publishing', 'نشر مجدول')]] }, sfx: ['tick@0.35', 'tick@0.7', 'tick@1.05'] },
      { t: 'ctaTap', d: 4.0, tr: 'zoom', cap: T('Syveka Studio – sisältöstudio yrityksellesi.', 'Syveka Studio — a content studio for your business.', 'Syveka Studio — استوديو محتوى لشركتك.'), p: { btn: CTA_EARLY }, sfx: ['pop@1.7', 'chime@1.9'] },
      { t: 'end', d: 5.0, tr: 'fade' },
    ],
  }, ST),
});
