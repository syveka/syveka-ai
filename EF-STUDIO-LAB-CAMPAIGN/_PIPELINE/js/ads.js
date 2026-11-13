// Campaign content: 12 ads × FI / EN / AR. Single source of truth for video, subtitles and scripts.
// CONTACT: set to a verified website / phone / email to show it on every end card, then re-render.
// Left empty on purpose — no contact detail was verified, and none may be invented.
const CONTACT = '';

const CTA_CONTACT = T('Ota yhteyttä', 'Get in touch', 'تواصل معنا');
const CTA_CONSULT = T('Pyydä kartoitus', 'Request a consultation', 'اطلب استشارة');

const ADS = {
  AD01: {
    title: T('Vastaamaton asiakas', 'The Missed Customer', 'العميل الذي لم يُرَدّ عليه'), board: 1, music: 'tension',
    tagline: T('Älykkäämpi tapa palvella asiakkaita.', 'A smarter way to serve your customers.', 'طريقة أذكى لخدمة عملائك.'), cta: CTA_CONTACT,
    scenes: [
      { t: 'storm', d: 4.6, sub: T('Kuinka moni asiakas jäi tänään ilman vastausta?', 'How many customers went unanswered today?', 'كم عميلاً بقي اليوم بلا رد؟'), p: { hook: T('Kuinka moni asiakas jäi tänään *ilman vastausta?*', 'How many customers went *unanswered* today?', 'كم عميلاً بقي اليوم *بلا رد؟*') }, sfx: ['ding@0.2', 'ding@0.65', 'ding@1.1', 'ding@1.5'] },
      { t: 'chatWait', d: 4.6, tr: 'side', cap: T('Viesti lähti. Vastausta ei kuulunut.', 'A message was sent. No reply came.', 'وصلت الرسالة. ولم يصل الرد.'), p: { msg1: T('Hei! Onko teillä vapaita aikoja tällä viikolla?', 'Hi! Do you have any openings this week?', 'مرحباً! هل لديكم مواعيد متاحة هذا الأسبوع؟'), msg2: T('Onko siellä ketään?', 'Is anyone there?', 'هل من أحد هنا؟') }, sfx: ['pop@0.5', 'pop@2.3'] },
      { t: 'funnel', d: 4.6, tr: 'zoom', cap: T('Entä jos yhteydenotot eivät enää hukkuisi?', 'What if inquiries stopped slipping through?', 'ماذا لو لم تَضِع أي رسالة بعد اليوم؟'), sfx: ['rise@0.3', 'chime@2.1'] },
      { t: 'sorted', d: 5.2, tr: 'up', concept: true, cap: T('Selkeä digitaalinen työnkulku kokoaa, jäsentää ja ohjaa ne oikeaan paikkaan.', 'A clear digital workflow gathers, sorts and routes them to the right place.', 'مسار رقمي واضح يجمعها وينظّمها ويوجّهها إلى مكانها الصحيح.'), sfx: ['tick@0.3', 'tick@0.62', 'tick@0.94', 'tick@1.26'] },
      { t: 'calm', d: 3.8, tr: 'fade', cap: T('Sinä keskityt työhösi. Rauhassa.', 'You focus on your work. Calmly.', 'وأنت تركّز على عملك. بهدوء.'), p: { chip: T('Yhteydenotot järjestyksessä', 'Inquiries in order', 'الطلبات منظَّمة') } },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  AD02: {
    title: T('Verkkosivujen muodonmuutos', 'Website Transformation', 'تحوّل الموقع الإلكتروني'), board: 2, music: 'bright',
    tagline: T('Verkkosivut, jotka tekevät vaikutuksen.', 'Websites that make an impression.', 'مواقع تترك انطباعاً.'), cta: CTA_CONSULT,
    scenes: [
      { t: 'oldDesk', d: 4.4, sub: T('Onko yrityksesi verkkosivusto ajan tasalla?', "Is your company's website up to date?", 'هل موقع شركتك مواكب للعصر؟'), p: { hook: T('Onko yrityksesi verkkosivusto *ajan tasalla?*', "Is your company's website *up to date?*", 'هل موقع شركتك *مواكب للعصر؟*') } },
      { t: 'oldPhone', d: 4.8, tr: 'side', cap: T('Jos tieto ei löydy heti, asiakas jatkaa matkaa.', "If customers can't find it fast, they move on.", 'إن لم يجد العميل المعلومة سريعاً، سيمضي إلى غيرك.') },
      { t: 'morph', d: 4.2, tr: 'fade', cap: T('Aika päivittää.', 'Time for an upgrade.', 'حان وقت التجديد.'), sfx: ['rise@0.6', 'chime@2.7'] },
      { t: 'showcase', d: 5.2, tr: 'zoom', concept: true, cap: T('Moderni, nopea ja selkeä – kaikilla laitteilla.', 'Modern, fast and clear — on every device.', 'عصري وسريع وواضح — على كل الأجهزة.') },
      { t: 'siteClose', d: 4.2, tr: 'up', light: true, capbg: false, capo: { dark: true }, cap: T('Suunnittelemme sivuston, joka näyttää yritykseltäsi.', 'We design a website that looks like your business.', 'نصمّم موقعاً يعكس هوية شركتك.'), sfx: ['pop@2.1'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  AD03: {
    title: T('Tekoälyavustaja', 'The AI Assistant', 'المساعد الذكي'), board: 3, music: 'future',
    tagline: T('Tekoälyautomaatio yrityksesi tarpeisiin.', 'AI automation, shaped around your business.', 'أتمتة ذكية مصمَّمة لاحتياجات عملك.'),
    cta: T('Kysy, mitä voimme rakentaa', 'Ask what we can build', 'اسأل عمّا يمكننا بناؤه'),
    note: T('Ratkaisut suunnitellaan tapauskohtaisesti.', 'Solutions are designed case by case.', 'تُصمَّم الحلول حسب كل حالة.'),
    scenes: [
      { t: 'closing', d: 5.0, sub: T('Entä jos asiakaspalvelusi voisi auttaa myös työajan jälkeen?', 'What if your customer service could help after hours, too?', 'ماذا لو استطاعت خدمة عملائك المساعدة بعد ساعات العمل أيضاً؟'), p: { hook: T('Entä jos asiakaspalvelusi voisi auttaa myös *työajan jälkeen?*', 'What if your customer service could help *after hours,* too?', 'ماذا لو ساعدت خدمة عملائك *بعد ساعات العمل* أيضاً؟') }, sfx: ['tick@2.4'] },
      { t: 'nightMsg', d: 4.2, tr: 'down', cap: T('Illalla saapuu viesti.', 'That evening, a message arrives.', 'في المساء، تصل رسالة.'), p: { msg: T('Hei, voisinko saada tarjouksen ensi viikolle?', 'Hi, could I get a quote for next week?', 'مرحباً، هل يمكنني الحصول على عرض سعر للأسبوع القادم؟') }, sfx: ['ding@1.5'] },
      { t: 'aiOrb', d: 5.2, tr: 'iris', concept: true, cap: T('Tekoälyavustaja voi ottaa kysymyksen vastaan ja kirjata sen talteen.', 'An AI assistant can receive the question and log it for you.', 'يمكن لمساعد ذكي أن يستقبل السؤال ويسجّله لك.'), p: { q: T('Hei, voisinko saada tarjouksen ensi viikolle?', 'Hi, could I get a quote for next week?', 'مرحباً، هل يمكنني الحصول على عرض سعر للأسبوع القادم؟'), a: T('Kiitos viestistäsi! Kirjasin pyyntösi, ja palaamme asiaan heti aamulla.', "Thanks for your message! I've logged your request and we'll get back to you first thing in the morning.", 'شكراً لرسالتك! سجّلتُ طلبك وسنعود إليك في الصباح.') }, sfx: ['rise@0.1', 'pop@0.5'] },
      { t: 'ticket', d: 4.6, tr: 'up', concept: true, cap: T('Aamulla kaikki odottaa valmiina seurantaa varten.', 'By morning, everything is ready for follow-up.', 'وفي الصباح، كل شيء جاهز للمتابعة.'), p: { rows: [[T('Aihe', 'Topic', 'الموضوع'), T('Tarjouspyyntö', 'Quote request', 'طلب عرض سعر')], [T('Ajankohta', 'Timing', 'التوقيت'), T('Ensi viikko', 'Next week', 'الأسبوع القادم')], [T('Kanava', 'Channel', 'القناة'), T('Verkkosivun chat', 'Website chat', 'محادثة الموقع')], [T('Seuraava askel', 'Next step', 'الخطوة التالية'), T('Soitto asiakkaalle', 'Call the customer', 'الاتصال بالعميل')]] }, sfx: ['tick@0.8', 'tick@1.08', 'tick@1.36', 'tick@1.64'] },
      { t: 'morning', d: 4.0, tr: 'fade', light: false, cap: T('Sinä päätät, miten jatketaan.', 'You decide what happens next.', 'وأنت تقرّر الخطوة التالية.'), p: { sum: T('Tarjouspyyntö ensi viikolle – tiedot kirjattu valmiiksi.', 'Quote request for next week — details already logged.', 'طلب عرض سعر للأسبوع القادم — التفاصيل مسجَّلة.') }, sfx: ['chime@0.3'] },
      { t: 'end', d: 4.8, tr: 'fade' },
    ],
  },
  AD04: {
    title: T('Kauneussalongin digikokemus', 'Beauty Salon Digital Experience', 'التجربة الرقمية لصالون التجميل'), board: 4, music: 'warm',
    tagline: T('Digitaalinen ilme kauneusalalle.', 'A digital presence for beauty businesses.', 'حضور رقمي لصالونات التجميل.'), cta: CTA_CONTACT,
    scenes: [
      { t: 'setpiece', d: 4.4, sub: T('Kampaamosi ensivaikutelma syntyy jo ennen ovea.', "Your salon's first impression happens before the door.", 'الانطباع الأول عن صالونك يبدأ قبل الباب.'), p: { icon: 'scissors', bg: 'rose', shape: 'arch', hook: T('Kampaamosi ensivaikutelma syntyy jo *ennen ovea.*', "Your salon's first impression happens *before the door.*", 'الانطباع الأول عن صالونك يبدأ *قبل الباب.*') } },
      { t: 'search', d: 4.4, tr: 'up', cap: T('Asiakas etsii sinua ensin puhelimellaan.', 'Customers look you up on their phone first.', 'العميل يبحث عنك أولاً من هاتفه.'), p: { bg: 'rose', q: T('kampaamo lähellä', 'hair salon near me', 'صالون تجميل قريب') }, sfx: ['type@0.7'] },
      { t: 'sitePhone', d: 5.0, tr: 'zoom', concept: true, cap: T('Kauniit sivut kertovat palvelut ja tunnelman yhdellä silmäyksellä.', 'A beautiful site shows your services and your style at a glance.', 'موقع أنيق يعرض خدماتك وأجواء صالونك بنظرة واحدة.'), p: { site: 'salon', bg: 'rose' } },
      { t: 'booking', d: 5.0, tr: 'side', concept: true, cap: T('Ja ajanvarauspyyntö onnistuu silloin, kun asiakkaalle sopii.', 'And a booking request works whenever it suits them.', 'وطلب الحجز متاح في الوقت الذي يناسب العميل.'), p: { bg: 'rose' }, sfx: ['pop@1.6', 'pop@2.9', 'chime@3.3'] },
      { t: 'quiet', d: 4.0, tr: 'fade', cap: T('Sinä keskityt asiakkaaseen tuolissasi.', 'You stay focused on the client in your chair.', 'وأنت تتفرّغ لمن يجلس على كرسيك.'), p: { bg: 'rose', icon: 'scissors', text: T('Uusi varauspyyntö', 'New booking request', 'طلب حجز جديد'), sub: T('Torstai 14:30 · Hiustenleikkaus', 'Thursday 14:30 · Haircut', 'الخميس 14:30 · قصّ الشعر') }, sfx: ['ding@1.2'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  AD05: {
    title: T('Korjaamon automaatio', 'Workshop Automation', 'أتمتة ورشة السيارات'), board: 4, music: 'drive',
    tagline: T('Sujuvampi arki korjaamolle.', 'A smoother day at the workshop.', 'يوم عمل أكثر سلاسة لورشتك.'), cta: CTA_CONSULT,
    scenes: [
      { t: 'ringing', d: 4.4, sub: T('Kädet öljyssä. Puhelin soi taas.', 'Hands deep in an engine. The phone rings again.', 'يداك مشغولتان بالمحرّك. والهاتف يرنّ من جديد.'), p: { hook: T('Kädet öljyssä.\n*Puhelin soi taas.*', 'Hands deep in an engine.\n*The phone rings again.*', 'يداك مشغولتان بالمحرّك.\n*والهاتف يرنّ من جديد.*') }, sfx: ['ring@0.9', 'ring@2.3'] },
      { t: 'channels', d: 4.8, tr: 'diag', cap: T('Huoltokyselyt, renkaanvaihdot, tarjouspyynnöt – kaikki eri kanavista.', 'Service requests, tyre changes, quote requests — all from different channels.', 'طلبات الصيانة وتبديل الإطارات وعروض الأسعار — من قنوات متفرقة.'), sfx: ['pop@0.3', 'pop@0.8', 'pop@1.3'] },
      { t: 'form', d: 5.0, tr: 'up', concept: true, cap: T('Yksi lomake verkossa kerää tiedot valmiiksi.', 'One online form collects the details up front.', 'نموذج واحد على الإنترنت يجمع التفاصيل مسبقاً.'), p: { title: T('Huoltopyyntö', 'Service request', 'طلب صيانة'), fields: [[T('Rekisterinumero', 'Registration number', 'رقم اللوحة'), 'ABC-123'], [T('Palvelu', 'Service', 'الخدمة'), T('Määräaikaishuolto', 'Scheduled service', 'صيانة دورية')], [T('Toivottu ajankohta', 'Preferred time', 'الموعد المفضّل'), T('Ensi viikko', 'Next week', 'الأسبوع القادم')]], btn: T('Lähetä pyyntö', 'Send request', 'إرسال الطلب') }, sfx: ['type@0.6', 'type@1.5', 'type@2.4', 'pop@3.5'] },
      { t: 'queue', d: 5.0, tr: 'side', concept: true, cap: T('Automaatio järjestää pyynnöt jonoon ja muistuttaa seurannasta.', 'Automation queues the requests and reminds you to follow up.', 'والأتمتة ترتّب الطلبات وتذكّرك بالمتابعة.'), sfx: ['tick@0.5', 'tick@0.9', 'tick@1.3', 'ding@2.8'] },
      { t: 'statement', d: 3.8, tr: 'zoom', sub: T('Vähemmän keskeytyksiä. Enemmän valmista.', 'Fewer interruptions. More work done.', 'مقاطعات أقل. وإنجاز أكثر.'), p: { bg: 'steel', icon: 'gear', spin: 90, top: 820, text: T('Vähemmän keskeytyksiä.\n*Enemmän valmista.*', 'Fewer interruptions.\n*More work done.*', 'مقاطعات أقل.\n*وإنجاز أكثر.*') } },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  AD06: {
    title: T('Siivousyrityksen liidit', 'Cleaning Company Leads', 'طلبات عملاء شركة التنظيف'), board: 4, music: 'bright',
    tagline: T('Liidit hallintaan.', 'Your leads, under control.', 'طلبات عملائك تحت السيطرة.'), cta: CTA_CONTACT,
    scenes: [
      { t: 'notes', d: 4.6, sub: T('Tarjouspyyntö tuli tiistaina. Kuka vastasi siihen?', 'A quote request came in on Tuesday. Who answered it?', 'وصل طلب عرض سعر يوم الثلاثاء. من ردّ عليه؟'), p: { hook: T('Tarjouspyyntö tuli tiistaina.\n*Kuka vastasi siihen?*', 'A quote request came in on Tuesday.\n*Who answered it?*', 'وصل طلب عرض سعر يوم الثلاثاء.\n*من ردّ عليه؟*') } },
      { t: 'scatter', d: 4.8, tr: 'fade', cap: T('Kun liidit ovat sähköpostissa, muistilapuissa ja päässä, osa unohtuu.', 'When leads live in email, sticky notes and your head, some get forgotten.', 'حين تتوزّع الطلبات بين البريد والملاحظات والذاكرة، يُنسى بعضها.') },
      { t: 'gather', d: 4.2, tr: 'zoom', cap: T('Kootaan ne yhteen näkymään.', 'Bring them into one view.', 'اجمعها في لوحة واحدة.'), sfx: ['rise@0.2', 'chime@2.2'] },
      { t: 'kanban', d: 5.2, tr: 'up', concept: true, cap: T('Uusi, tarjottu, sovittu – näet tilanteen heti.', 'New, quoted, booked — see where things stand instantly.', 'جديد، تم التسعير، مؤكَّد — ترى الحالة فوراً.'), sfx: ['tick@1.6', 'tick@2.6'] },
      { t: 'statement', d: 3.8, tr: 'fade', sub: T('Jokainen yhteydenotto saa paikkansa.', 'Every inquiry gets its place.', 'لكل طلب مكانه.'), p: { bg: 'fresh', icon: 'sparkle', top: 820, text: T('Jokainen yhteydenotto\n*saa paikkansa.*', 'Every inquiry\n*gets its place.*', 'لكل طلب\n*مكانه.*') } },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  AD07: {
    title: T('Muuttofirman digivaraus', 'Moving Company Digital Booking', 'الحجز الرقمي لشركة النقل'), board: 4, music: 'drive',
    tagline: T('Digitaalinen varaus muuttoalalle.', 'Digital booking for moving companies.', 'حجز رقمي لشركات نقل الأثاث.'), cta: CTA_CONSULT,
    scenes: [
      { t: 'calendar', d: 4.6, sub: T('Muuttopäivä lähestyy. Asiakas haluaa varata nyt.', 'Moving day is coming. Your customer wants to book now.', 'يوم الانتقال يقترب. وعميلك يريد الحجز الآن.'), p: { hook: T('Muuttopäivä lähestyy.\n*Asiakas haluaa varata nyt.*', 'Moving day is coming.\n*Your customer wants to book now.*', 'يوم الانتقال يقترب.\n*وعميلك يريد الحجز الآن.*') }, sfx: ['tick@1.4'] },
      { t: 'phoneTag', d: 4.6, tr: 'side', cap: T('Puhelinralli ja viestiketjut hidastavat kaikkia.', 'Phone tag and long message threads slow everyone down.', 'المكالمات المتبادلة وسلاسل الرسائل تؤخّر الجميع.'), sfx: ['ring@0.3', 'ring@1.5', 'ring@2.7'] },
      { t: 'stepper', d: 5.2, tr: 'up', concept: true, cap: T('Verkossa asiakas kertoo itse: mistä, minne ja milloin.', 'Online, customers tell you themselves: from where, to where, and when.', 'على الإنترنت يخبرك العميل بنفسه: من أين، وإلى أين، ومتى.'), sfx: ['type@0.5', 'type@1.5', 'type@2.5'] },
      { t: 'requestCard', d: 4.8, tr: 'zoom', concept: true, cap: T('Sinä saat selkeän varauspyynnön – valmiina vahvistettavaksi.', 'You get a clear booking request — ready to confirm.', 'ويصلك طلب حجز واضح — جاهز للتأكيد.'), sfx: ['pop@2.6', 'chime@2.9'] },
      { t: 'route', d: 4.0, tr: 'fade', cap: T('Helpompi varata. Helpompi suunnitella.', 'Easier to book. Easier to plan.', 'حجز أسهل. وتخطيط أسهل.') },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  AD08: {
    title: T('Ravintolan asiakaskokemus', 'Restaurant Guest Experience', 'تجربة ضيوف المطعم'), board: 4, music: 'warm',
    tagline: T('Parempi asiakaskokemus ravintolallesi.', 'A better guest experience for your restaurant.', 'تجربة أفضل لضيوف مطعمك.'), cta: CTA_CONTACT,
    scenes: [
      { t: 'setpiece', d: 4.2, sub: T('Nälkäinen asiakas päättää sekunneissa.', 'A hungry customer decides in seconds.', 'الزبون الجائع يحسم قراره في ثوانٍ.'), p: { icon: 'cloche', bg: 'wine', shape: 'table', hook: T('Nälkäinen asiakas päättää *sekunneissa.*', 'A hungry customer decides *in seconds.*', 'الزبون الجائع يحسم قراره *في ثوانٍ.*') } },
      { t: 'questions', d: 4.8, tr: 'fade', sub: T('Missä menu on? Oletteko auki? Saako pöydän?', "Where's the menu? Are you open? Can I get a table?", 'أين قائمة الطعام؟ هل أنتم مفتوحون؟ هل من طاولة؟'), p: { qs: [T('Missä menu on?', "Where's the menu?", 'أين قائمة الطعام؟'), T('Oletteko auki?', 'Are you open?', 'هل أنتم مفتوحون؟'), T('Saako pöydän?', 'Can I get a table?', 'هل من طاولة؟')] }, sfx: ['pop@0.3', 'pop@1.2', 'pop@2.1'] },
      { t: 'sitePhone', d: 4.6, tr: 'zoom', concept: true, cap: T('Hyvä sivusto vastaa kaikkeen heti.', 'A good website answers it all, instantly.', 'الموقع الجيد يجيب عن كل ذلك فوراً.'), p: { site: 'resto', bg: 'wine', tilt: -1 } },
      { t: 'trio', d: 5.0, tr: 'up', cap: T('Menu, aukioloajat ja pöytävarauspyyntö – samassa paikassa.', 'Menu, opening hours and table requests — in one place.', 'القائمة وساعات العمل وطلب حجز الطاولة — في مكان واحد.'), sfx: ['tick@0.4', 'tick@1.3', 'tick@2.2'] },
      { t: 'evening', d: 4.2, tr: 'fade', cap: T('Ja ilta alkaa jo ennen kuin ovi aukeaa.', 'And the evening begins before the door even opens.', 'وتبدأ الأمسية قبل أن يُفتح الباب.') },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  AD09: {
    title: T('Yrittäjän aika', "The Owner's Time", 'وقت صاحب العمل'), board: 3, music: 'tension',
    tagline: T('Vähemmän rutiinia. Enemmän yrittämistä.', 'Less routine. More business.', 'روتين أقل. وأعمال أكثر.'), cta: CTA_CONSULT,
    scenes: [
      { t: 'ring24', d: 4.8, sub: T('Yrittäjän päivässä on 24 tuntia. Mihin sinun menevät?', "An entrepreneur's day has 24 hours. Where do yours go?", 'في يوم صاحب العمل 24 ساعة. أين تذهب ساعاتك؟'), p: { hook: T('Päivässä on 24 tuntia.\n*Mihin sinun menevät?*', 'A day has 24 hours.\n*Where do yours go?*', 'في اليوم 24 ساعة.\n*أين تذهب ساعاتك؟*') }, sfx: ['tick@0.5', 'tick@1.0', 'tick@1.5'] },
      { t: 'repeat', d: 4.6, tr: 'side', cap: T('Samat vastaukset. Samat kirjaukset. Yhä uudelleen.', 'The same replies. The same data entry. Again and again.', 'الردود نفسها. والإدخالات نفسها. مرة بعد مرة.'), sfx: ['pop@0.3', 'pop@0.8', 'pop@1.3', 'pop@1.8', 'pop@2.3'] },
      { t: 'automate', d: 4.6, tr: 'zoom', concept: true, cap: T('Toistuvat rutiinit voi usein automatisoida.', 'Repetitive routines can often be automated.', 'المهام المتكررة يمكن أتمتتها في كثير من الأحيان.'), sfx: ['rise@0.2', 'chime@2.6'] },
      { t: 'blueprint', d: 5.0, tr: 'up', cap: T('Me kartoitamme, mikä kannattaa – ja rakennamme sen.', "We map out what's worth it — and build it.", 'نحدّد ما يستحق الأتمتة — ونبنيه لك.'), sfx: ['tick@0.6', 'tick@1.1', 'tick@1.6'] },
      { t: 'ring24', d: 4.0, tr: 'fade', cap: T('Sinulle jää aikaa siihen, mikä on tärkeintä.', 'So you have time for what matters most.', 'ليبقى لك وقت لما هو أهم.'), p: { free: true } },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  AD10: {
    title: T('Ammattimaiset verkkosivut', 'Professional Website Showcase', 'مواقع إلكترونية احترافية'), board: 2, music: 'luxe',
    tagline: T('Ammattimaiset verkkosivut yrityksellesi.', 'Professional websites for your business.', 'مواقع احترافية لشركتك.'), cta: CTA_CONSULT,
    scenes: [
      { t: 'bizcard', d: 4.8, sub: T('Sivustosi on yrityksesi käyntikortti. Ja se on auki aina.', 'Your website is your business card. And it never closes.', 'موقعك هو بطاقة عملك. ولا يُغلق أبداً.'), p: { hook: T('Sivustosi on yrityksesi käyntikortti.\n*Ja se on auki aina.*', 'Your website is your business card.\n*And it never closes.*', 'موقعك هو بطاقة عملك.\n*ولا يُغلق أبداً.*') } },
      { t: 'wire', d: 3.6, tr: 'up', cap: T('Selkeä rakenne.', 'Clear structure.', 'بنية واضحة.'), sfx: ['tick@0.3', 'tick@0.7', 'tick@1.1', 'tick@1.5'] },
      { t: 'wire', d: 3.8, tr: 'fade', concept: true, cap: T('Harkittu ulkoasu.', 'Considered design.', 'تصميم مدروس.'), p: { styled: true }, sfx: ['rise@0.2'] },
      { t: 'responsive', d: 4.8, tr: 'zoom', concept: true, cap: T('Toimii puhelimella, tabletilla ja tietokoneella.', 'Works on phone, tablet and desktop.', 'يعمل على الهاتف والجهاز اللوحي والحاسوب.') },
      { t: 'langSwitch', d: 4.6, tr: 'side', concept: true, cap: T('Suomeksi – ja tarvittaessa muillakin kielillä.', 'In Finnish — and in other languages when you need them.', 'بالفنلندية — وبلغات أخرى عند الحاجة.'), sfx: ['pop@1.3', 'pop@2.6'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
  AD11: {
    title: T('Brändifilmi', 'Premium Brand Film', 'فيلم العلامة'), board: 5, music: 'luxe',
    tagline: T('Suomalaisille yrityksille. Fiksumpia digiratkaisuja.', 'Smarter digital solutions for Finnish businesses.', 'حلول رقمية أذكى للشركات في فنلندا.'), cta: CTA_CONTACT,
    scenes: [
      { t: 'spark', d: 3.8, cap: T('Jokainen yritys alkaa ideasta.', 'Every business begins with an idea.', 'كل عمل يبدأ بفكرة.'), capbg: false, sfx: ['boom@0.2'] },
      { t: 'network', d: 4.4, tr: 'cut', cap: T('Kasvu alkaa yhteyksistä.', 'Growth begins with connections.', 'والنموّ يبدأ بالتواصل.'), capbg: false, sfx: ['rise@0.2'] },
      { t: 'montage', d: 5.0, tr: 'cut', sub: T('Verkkosivut. Asiakasviestintä. Tekoäly. Automaatio.', 'Websites. Customer communication. AI. Automation.', 'مواقع. تواصل مع العملاء. ذكاء اصطناعي. أتمتة.'), p: { words: [['web', T('Verkkosivut', 'Websites', 'مواقع')], ['chat', T('Asiakasviestintä', 'Customer communication', 'تواصل مع العملاء')], ['ai', T('Tekoäly', 'AI', 'ذكاء اصطناعي')], ['bolt', T('Automaatio', 'Automation', 'أتمتة')]] }, sfx: ['hit@0', 'hit@1.25', 'hit@2.5', 'hit@3.75'] },
      { t: 'ecosystem', d: 4.8, tr: 'zoom', cap: T('Yksi kokonaisuus, joka toimii yhdessä.', 'One whole that works together.', 'منظومة واحدة تعمل بتناغم.'), capbg: false },
      { t: 'bigtype', d: 3.6, tr: 'cut', sub: T('Yrityksesi. Fiksummin.', 'Your business. Smarter.', 'أعمالك. بذكاء أكبر.'), p: { a: T('Yrityksesi.', 'Your business.', 'أعمالك.'), b: T('Fiksummin.', 'Smarter.', 'بذكاء أكبر.') }, sfx: ['boom@0.1'] },
      { t: 'end', d: 5.0, tr: 'fade' },
    ],
  },
  AD12: {
    title: T('Pyydä kartoitus', 'Request a Consultation', 'اطلب استشارة'), board: 4, music: 'bright',
    tagline: T('Aloitetaan keskustelusta.', "Let's start with a conversation.", 'لنبدأ بمحادثة.'), cta: CTA_CONSULT,
    scenes: [
      { t: 'city', d: 4.0, sub: T('Yrittäjä, pysähdy hetkeksi.', 'Business owner — pause for a second.', 'يا صاحب العمل، توقّف لحظة.'), p: { hook: T('Yrittäjä,\n*pysähdy hetkeksi.*', 'Business owner —\n*pause for a second.*', 'يا صاحب العمل،\n*توقّف لحظة.*') } },
      { t: 'checklist', d: 5.2, tr: 'up', sub: T('Jääkö viestejä vastaamatta? Onko sivustosi vanhentunut? Viekö rutiini aikasi?', 'Messages going unanswered? Website out of date? Routine eating your time?', 'رسائل بلا رد؟ موقع قديم؟ روتين يستهلك وقتك؟'), p: { qs: [['chat', T('Jääkö viestejä vastaamatta?', 'Messages going unanswered?', 'رسائل بلا رد؟')], ['web', T('Onko sivustosi vanhentunut?', 'Website out of date?', 'موقع قديم؟')], ['clock', T('Viekö rutiini aikasi?', 'Routine eating your time?', 'روتين يستهلك وقتك؟')]] }, sfx: ['pop@0.4', 'pop@1.5', 'pop@2.6'] },
      { t: 'convo', d: 4.2, tr: 'side', cap: T('Yksi keskustelu riittää alkuun.', 'One conversation is enough to start.', 'محادثة واحدة تكفي للبداية.'), p: { a: T('Hei! Haluaisin kuulla, miten voisitte auttaa yritystäni.', "Hi! I'd like to hear how you could help my business.", 'مرحباً! أودّ أن أعرف كيف يمكنكم مساعدة عملي.'), b: T('Kerro tilanteestasi – käydään se yhdessä läpi.', "Tell us about your situation — let's go through it together.", 'أخبرنا عن وضعك — ولنراجعه معاً.') }, sfx: ['pop@0.5', 'pop@1.8'] },
      { t: 'steps', d: 5.0, tr: 'up', cap: T('Selkeä kuva siitä, mitä kannattaa tehdä.', "A clear picture of what's worth doing.", 'صورة واضحة لما يستحق التنفيذ.'), p: { steps: [T('Kerro tilanteesi', 'Tell us your situation', 'أخبرنا بوضعك'), T('Käymme vaihtoehdot läpi', 'We walk through the options', 'نستعرض الخيارات معاً'), T('Sinä päätät', 'You decide', 'والقرار لك')] }, sfx: ['tick@0.4', 'tick@1.3', 'tick@2.2'] },
      { t: 'ctaTap', d: 3.8, tr: 'zoom', cap: T('Suomalaisille yrityksille. Fiksumpia digiratkaisuja.', 'Smarter digital solutions for Finnish businesses.', 'حلول رقمية أذكى للشركات في فنلندا.'), p: { btn: CTA_CONSULT }, sfx: ['pop@1.7', 'chime@1.9'] },
      { t: 'end', d: 4.6, tr: 'fade' },
    ],
  },
};
