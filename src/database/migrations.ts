import type { PoolConnection, Pool } from 'mysql2/promise';

/**
 * Ordered, append-only schema migrations. Each entry runs exactly once; applied
 * names are recorded in `schema_migrations`. Statements must be idempotent so a
 * partially-applied legacy install can still be upgraded in place.
 */
export interface Migration {
  name: string;
  up: (conn: PoolConnection) => Promise<void>;
}

const HISTORY_ANSWERS = {
  en: {
    question: 'What is our history?',
    alternatives: ['our history', 'tell me your history', 'history of yemisrach dimts', 'when did ydcs start', 'founding', 'how long have you existed'],
    keywords: ['history', 'founded', 'years', 'since', '1963', 'started', 'began'],
    answer: "Our History\n1950s — Early History — A Christian Literature Project: The ministry began as a Christian literature project that produced and distributed books and other printed materials. As technology developed, the organization expanded into radio broadcasting to reach more people across Ethiopia and neighboring countries.\n1963 — Radio Ministry Begins: On February 26, 1963, YDCS started its first radio broadcasts. The programs were designed to teach, encourage, and serve people from different backgrounds. The broadcasts included Bible teaching, Christian music, news, family and marriage advice, health education, agriculture information, children's programs, youth programs, and educational programs. Programs were produced in Amharic and later in several other Ethiopian languages so that more people could hear the message in their own language.\n1970s — Growth and Expansion: As the ministry grew, YDCS built modern recording studios and expanded its production work. The organization became well known for producing high-quality Christian radio programs and music recordings. Many Ethiopian churches, choirs, and gospel singers used the YDCS studio to record their music and messages.\n1977 — Difficult Times: In 1977, during Ethiopia's military government (the Derg era), the government took control of the YDCS buildings and radio facilities. Many valuable recordings, documents, and equipment were lost or confiscated. Although this was a major setback, the ministry did not stop.\nPost-1977 — Continuing the Ministry: After losing its radio station, YDCS continued sharing the Gospel by recording Christian music, producing cassette tapes, publishing Christian literature, supporting churches, training Christian workers, and preserving historical Christian recordings throughout Ethiopia. The ministry continued serving believers despite many challenges.\n1980s–1990s — Gospel Music Contribution: YDCS played an important role in the growth of Ethiopian gospel music. Many famous gospel artists and church choirs recorded their first albums at the YDCS recording studio, helping spread Christian music across the country.\n1991-2001 — Preserving History, Spreading the Gospel: Today, YDCS keeps and protects many historical recordings from the early years of Christian broadcasting in Ethiopia. These archives are valuable for churches, researchers, and future generations because they preserve an important part of Ethiopia's Christian heritage.\nNow — Mission Today: YDCS continues its mission of sharing the Gospel through media by producing Christian content, supporting churches, preserving historical archives, and embracing modern communication technologies to reach people with the message of Jesus Christ. Through Internet Radio, Radio Homes, Printing Media, Christian Literature, and Vestments and Christian Bookshops, as well as digital platforms such as Facebook, YouTube, TikTok, Telegram, and other social media channels, YDCS is expanding its reach and making Christian messages, teachings, music, literature, and programs accessible to people across Ethiopia and beyond.",
  },
  am: {
    question: 'ታሪካችን ምንድን ነው?',
    alternatives: ['ታሪካችን', 'ታሪካችሁን ንገሩኝ', 'የምስራች ድምጽ ታሪክ', 'መቼ ጀመረ'],
    keywords: ['ታሪክ', 'መመስረት', 'ዓመት', '1963', 'ጀመረ'],
    answer: `ታሪካችን
1950ዎች — የመጀመሪያ ታሪክ — የክርስቲያን ሥነ-ጽሑፍ ፕሮጀክት: አገልግሎቱ መጻሕፍትንና ሌሎች የታተሙ ጽሑፎችን በማዘጋጀትና በማሰራጨት የክርስቲያን ሥነ-ጽሑፍ ፕሮጀክት ሆኖ ተጀመረ። ቴክኖሎጂ እየተራመደ ሲሄድ ድርጅቱ በኢትዮጵያ እና በጎረቤት ሀገራት ብዙ ሰዎችን ለመድረስ ወደ ሬዲዮ ስርጭት ተስፋፋ።
1963 — የራዲዮ አገልግሎት ጀመረ: በየካቲት 26፣ 1963፣ የምስራች ድምጽ የመጀመሪያውን የራዲዮ ስርጭት ጀመረ። ፕሮግራሞቹ ከተለያዩ ማህበረሰቦች ለተገኙ ሰዎች ለማስተማር፣ ለማበረታታት እና ለማገልገል ተዘጋጅተው ነበር። ስርጭቶቹ የመጽሐፍ ቅዱስ ትምህርት፣ ክርስቲያናዊ ሙዚቃ፣ ዜና፣ የቤተሰብና የጋብቻ ምክር፣ የጤና ትምህርት፣ የግብርና መረጃ፣ የህጻናት ፕሮግራሞች፣ የወጣቶች ፕሮግራሞች እና ትምህርታዊ ፕሮግራሞችን ያካትቱ ነበር። ፕሮግራሞቹ በአማርኛ፣ በኋላም በሌሎች በርካታ የኢትዮጵያ ቋንቋዎች ይዘጋጁ ነበር፤ ይህም ብዙ ሰዎች መልእክቱን በራሳቸው ቋንቋ እንዲሰሙ ለማድረግ ነው።
1970ዎች — እድገት እና መስፋፋት: አገልግሎቱ እያደገ ሲሄድ የምስራች ድምጽ ዘመናዊ የቀረጻ ስቱዲዮዎችን በመገንባት የፕሮግራም ዝግጅት ስራውንም አስፋፋ። ድርጅቱ ከፍተኛ ጥራት ያላቸውን የክርስቲያናዊ ሬዲዮ ፕሮግራሞች እና የሙዚቃ ቀረጻዎች በማዘጋጀት በጣም ይታወቅ ነበር። ብዙ የኢትዮጵያ አብያተ ክርስቲያናት፣ መዘምራን እና ወንጌላውያን ዘማርያን ሙዚቃቸውንና መልእክቶቻቸውን ለመቅረጽ የምስራች ድምጽ ስቱዲዮን ተጠቅመዋል።
1977 — አስቸጋሪ ዘመን: በ1977፣ በኢትዮጵያ የወታደራዊ መንግሥት (የደርግ ዘመን) ዘመን መንግሥቱ የምስራች ድምጽ ሕንፃዎችን እና የራዲዮ ተቋማትን ተቆጣጠረ። ብዙ ዋጋ ያላቸው ቀረጻዎች፣ ሰነዶች እና መሳሪያዎች ጠፍተዋል ወይም ተወርሰዋል። ይህ ትልቅ እንቅፋት ቢሆንም አገልግሎቱ አልቆመም።
ከ1977 በኋላ — አገልግሎቱን መቀጠል: የራዲዮ ጣቢያውን ካጣ በኋላ የምስራች ድምጽ ክርስቲያናዊ ሙዚቃ በመቅረጽ፣ የካሴት ቴፖች በማዘጋጀት፣ ክርስቲያናዊ ሥነ-ጽሑፍን በማተም፣ አብያተ ክርስቲያናትን በመደገፍ፣ ክርስቲያናዊ ሰራተኞችን በማሰልጠን እና ታሪካዊ ክርስቲያናዊ ቀረጻዎችን በመላ ኢትዮጵያ በማዳረስ ወንጌልን ማሰራጨቱን ቀጠለ። አገልግሎቱ ብዙ ተግዳሮቶች ቢያጋጥሙትም ለአማኞች ማገልገሉን ቀጠለ።
1980ዎች–1990ዎች — ክርስቲያናዊ የሙዚቃ አስተዋፅዖ: የምስራች ድምጽ በኢትዮጵያ በወንጌል አማኞች የሙዚቃ እድገት ውስጥ ጉልህ ሚና ተጫውቷል። ብዙ ታዋቂ ወንጌላውያን እና የቤተክርስቲያን መዘምራን የመጀመሪያ አልበሞቻቸውን በየምስራች ድምጽ የቀረጻ ስቱዲዮ ቀርፀዋል፣ ይህም ክርስቲያናዊ ሙዚቃ በመላ ሀገሪቱ እንዲስፋፋ ረድቷል።
1991-2001 — ታሪክ በማስቀመጥ፣ ወንጌል በማስፋፋት: ዛሬ የምስራች ድምጽ ከክርስቲያናዊ ስርጭት ጥንታዊ ዘመን ብዙ ቀረጻዎችን ይጠብቃል እና ያስቀምጣል። እነዚህ ቤተ መዛግብት ለቤተክርስቲያኖች፣ ለተመራማሪዎች እና ለቀጣይ ትውልዶች ዋጋ ያላቸው ናቸው፣ ምክንያቱም የኢትዮጵያን ክርስቲያናዊ ቅርስ አስፈላጊ ክፍል ስለሚጠብቁ።
አሁን — የዛሬው ተልዕኮ: የምስራች ድምጽ ወንጌልን በሚዲያ በማስተላለፍ ተልዕኮውን በቀጣይነት እያከናወነ ሲሆን፣ ክርስቲያናዊ ይዘቶችን በማዘጋጀት፣ አብያተ ክርስቲያናትን በመደገፍ፣ ታሪካዊ ማህደሮችን በመጠበቅ እና ዘመናዊ የመገናኛ ቴክኖሎጂዎችን በመጠቀም የኢየሱስ ክርስቶስን መልዕክት ለሰዎች ያደርሳል። በኢንተርኔት ሬዲዮ፣ በሬዲዮ በየቤቱ፣ በሕትመት ሚዲያ፣ በክርስቲያናዊ ሥነ-ጽሑፍ፣ በክርስቲያናዊ አልባሳትና ልዩ ልዩ ቁሳቁሶች ሱቆች እንዲሁም እንደ ፌስቡክ፣ ዩቲዩብ፣ ቲክቶክ፣ ቴሌግራም እና ሌሎች የማህበራዊ ሚዲያ መድረኮች በመጠቀም፣ የምስራች ድምጽ የወንጌል መልዕክትን፣ የክርስቲያናዊ ትምህርቶችን፣ መዝሙሮችን፣ ሥነ-ጽሑፎችን እና የተለያዩ ፕሮግራሞችን በመላው ኢትዮጵያና ከኢትዮጵያ ውጭ ላሉ ሰዎች በቀላሉ እንዲደርሱ ያደርጋል።`,
  },
  om: {
    question: 'Seenaa keenya maalidha?',
    alternatives: ['seenaa keenya', 'seenaa keenyaa nii himi', 'seenaa sagalee missirachoo', 'yoom jalqabe'],
    keywords: ['seenaa', 'hundeeffama', 'waggaa', '1963', 'jalqabe'],
    answer: `Seenaa Keenya
1950ffama — Yeroo Jalqabaa — Pirojektii Barruulee Kiristaanaa: Tajaajilli kun jalqaba pirojektii barruulee Kiristaanaa taʼee kan hundaaʼe yoo taʼu, kitaabotaafi maxxansaalee biroo oomishuun raabsaa ture. Akkuma teeknooloojiin guddachaa deemee, dhaabbatichi tajaajila isaa gara tamsaasa raadiyootti babalʼisee, Itoophiyaafi biyyoota ollaa keessatti namoota hedduu bira gaʼuuf hojjachuu jalqabe.
1963 — Tajaajila Raadiyoo Jalqaba: Guurraandhala 26, 1963, YDCS tamsaasa raadiyoo jalqabe. Sagantootiinsa namoota garagaraa barsiisuuf,fi tajaajiluuf qophaa'ame — barsiisa Kitaaba Qulqulluu, muuziqaa Kiristaanaa, odeeffannoo, gorsa maatii, barsiisa fayyaa, barsiisa oomisha qonna, sagantoota daa'imoota, sagantoota hawwatoo, fi sagantoota barumsa. Sagantootiin Afaan Oromoo fi afaanota garaagaraa sagantaa qopheessuun namoota biraan geenya.
1970ffama — Guddinaa fi Babal’ina: Akkuma tajaajilli kun guddachaa dhufeen, YDCS Istuudiyoo waraabbii ammayyaa ijaaruun hojii oomishaa isaa babal’ise. Dhaabbatichi sagantaalee raadiyoo Kiristaanaa fi waraabbiiwwan muuziqaa qulqullina olaanaa qaban oomishuuf beekamaa taʼe. Waldoonni Kiristaanaa Itoophiyaa hedduun, faarfannaa fi faarfattoonni Wangeelaa baayʼeenis, muuziqaa fi ergaa isaanii waraabuuf istuudiyoo YDCS fayyadamu turan.
1977 — Yeroo Ari'atamaa: Bara 1977, yeroo mootummaa waraanaa Itoophiyaa (yeroo Dargii) keessatti, mootummaa sun ijaarsaalee fi meeshaalee tamsaasa raadiyoo YDCS toʼannoo isaa jala galche. Waraabbiiwwan sagalee gatii guddaa qaban, galmeewwan seenaa fi meeshaaleen hojii hedduun badan ykn mootummaa biratti qabaman. Kunis tajaajila kanaaf gufuu guddaa taʼus, YDCS hojii isaa hin dhaabne.
Booda 1977 — Tajaajiliin Itti Fufuu: Erga buufata raadiyoo isaa dhabee booda, YDCS Wangeela babalʼisuu itti fufe. Muuziqaa Kiristaanaa waraabuu, kasetiiwwan sagalee oomishuu, barruulee Kiristaanaa maxxansuu, waldoota Kiristaanaa deeggaruu, hojjettoota Kiristaanaa leenjisuu, akkasumas waraabbiiwwan seenaa Kiristaanaa guutummaa Itoophiyaa keessatti argaman kuusuu fi eeguudhaan tajaajila isaa itti fufe. Qormaataalee hedduu keessa darbus, tajaajilli kun amantoota tajaajiluu fi ergaa Wangeelaa babalʼisuu itti fufe.
1980ffama–1990ffama — Walii galtee Muuziqaa Wangeelaa: YDCS guddinaa fi babal’ina faarfannaa Wangeelaa Itoophiyaa keessatti gahee guddaa taphateera. faarfatoonni Wangeelaa beekamoo baay'eenii fi Kiristaanaa, albamoota isaanii jalqabaa mana sagalee YDCS keessatti waraabsiisaniiru. Kunis muuziqaa Kiristaanaa guutuu biyyattii keessatti akka babal’atuuf gumaachaa guddaa taasiseera.
1991-2001 — Seenaa Eeguu, Wangeela Labsuu: Har’a, YDCS waraabbiiwwan seenaa hedduu kanneen bara jalqaba tamsaasa Kiristaanaa Itoophiyaa irraa eegalee jiran ni kuusa, akkasumas ni eega. Kuusaaleen seenaa kun waldoota Kiristaanaa, qorattootaa fi dhaloota dhufuuf gatii guddaa qabu; sababni isaas, kutaa barbaachisaa dhaala Kiristaanaa Itoophiyaa ta’e ni tiksu.
Amma — Ergamaa Har'a: YDCS ergama isaa, karaa miidiyaatiin Wangeelaa tamsaasuu, itti fufsiisaa jira. Kunis qabiyyee Kiristaanaa oomishuu, waldoota Kiristaanaa deeggaruu, kuusaalee seenaa eeguu, akkasumas teeknooloojiiwwan qunnamtii ammayyaa fayyadamuun ergaa Yesuus Kiristoos namoota biraan ga’uudha.YDCS karaa Raadiyoo Intarneetii, Radio mana manaa, Maxxansaa, Barreeffamoota Kiristaanaa, uffata tajaajila amantii fi manneen kitaaba Kiristaanaa, akkasumas waltajjiiwwan dijitaalaa akka Facebook, YouTube, TikTok, Telegram fi chaanaaliiwwan miidiyaa hawaasaa biroo fayyadamuun daangaa tajaajila isaa babal’isaa jira. Karaa kanaan, YDCS ergaa Wangeelaa, barsiisaa, faarfannaa, barreeffamoota fi sagantaalee Kiristaanaa namoota Itoophiyaa keessa jiranii fi biyya alaa jiran biraan ga’uun, akka isaan argachuu fi dhaggeeffachuu danda’an taasisaa jira.`,
  },
};

const CREATE_TABLES: Migration[] = [
  {
    name: '001_create_users',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS users (
          id VARCHAR(36) PRIMARY KEY,
          username VARCHAR(255) UNIQUE NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password VARCHAR(255) NOT NULL,
          role ENUM('super_admin', 'admin') NOT NULL,
          token_version INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    // Installs created before token_version existed still need the column.
    // Duplicate-column (1060) and duplicate-key (1061) mean it is already there.
    name: '002_add_users_token_version',
    up: async (conn) => {
      try {
        await conn.execute(
          'ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0 AFTER role'
        );
      } catch (e: any) {
        if (e.errno !== 1060 && e.errno !== 1061) throw e;
      }
    },
  },
  {
    name: '003_create_programs',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS programs (
          id VARCHAR(36) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          cover_image VARCHAR(255),
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '004_create_tracks',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS tracks (
          id VARCHAR(36) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          artist VARCHAR(255),
          album VARCHAR(255),
          duration DOUBLE DEFAULT 0,
          file_path VARCHAR(255) NOT NULL,
          program_id VARCHAR(36) NOT NULL,
          track_type ENUM('episode', 'single', 'mix', 'live'),
          sort_order INT DEFAULT 0,
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '005_create_comments',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS comments (
          id VARCHAR(36) PRIMARY KEY,
          program_id VARCHAR(36) NOT NULL,
          guest_name VARCHAR(255) NOT NULL,
          content TEXT NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '006_create_likes',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS likes (
          id VARCHAR(36) PRIMARY KEY,
          track_id VARCHAR(36) NOT NULL,
          fingerprint VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_like (track_id, fingerprint),
          FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '007_create_listens',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS listens (
          id VARCHAR(36) PRIMARY KEY,
          track_id VARCHAR(36) NOT NULL,
          program_id VARCHAR(36) NOT NULL,
          fingerprint VARCHAR(255),
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE,
          FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '008_create_leaders',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS leaders (
          id VARCHAR(36) PRIMARY KEY,
          name VARCHAR(255) NOT NULL,
          title VARCHAR(255) NOT NULL,
          quote VARCHAR(500),
          role_label VARCHAR(255),
          photo VARCHAR(255),
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '009_create_albums',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS albums (
          id VARCHAR(36) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description VARCHAR(500),
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '010_create_album_photos',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS album_photos (
          id VARCHAR(36) PRIMARY KEY,
          album_id VARCHAR(36) NOT NULL,
          caption VARCHAR(500),
          file_name VARCHAR(255) NOT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (album_id) REFERENCES albums(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '011_create_announcements',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS announcements (
          id VARCHAR(36) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          body TEXT,
          pinned TINYINT(1) NOT NULL DEFAULT 0,
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '012_create_events',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS events (
          id VARCHAR(36) PRIMARY KEY,
          title VARCHAR(255) NOT NULL,
          description TEXT,
          location VARCHAR(255),
          starts_at DATETIME NOT NULL,
          ends_at DATETIME,
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '013_create_blog_posts',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS blog_posts (
          id VARCHAR(36) PRIMARY KEY,
          slug VARCHAR(255) UNIQUE NOT NULL,
          title VARCHAR(255) NOT NULL,
          excerpt VARCHAR(500),
          body MEDIUMTEXT,
          category VARCHAR(100),
          cover_image VARCHAR(255),
          published TINYINT(1) NOT NULL DEFAULT 1,
          created_by VARCHAR(36) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    // Extra photos shown inside the article body. Separate rows rather than a
    // JSON column so a single dropped photo is one DELETE, not a read-modify-
    // write of the whole post, and so the file can be unlinked by filename.
    name: '014_create_blog_images',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS blog_images (
          id VARCHAR(36) PRIMARY KEY,
          blog_post_id VARCHAR(36) NOT NULL,
          image VARCHAR(255) NOT NULL,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (blog_post_id) REFERENCES blog_posts(id) ON DELETE CASCADE
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    // Department tag on albums: NULL means "gallery only", one of the allowed
    // slugs mounts the album on that department's page. ALTER (not a 009 edit)
    // so databases that already applied 009 get the same schema.
    name: '015_create_album_department',
    up: async (conn) => {
      try {
        await conn.execute('ALTER TABLE albums ADD COLUMN department VARCHAR(64) NULL');
      } catch (e: any) {
        // 1060 = duplicate column: a fresh database that has since been given
        // the wider 009 definition already carries the column.
        if (e.errno !== 1060) throw e;
      }
      try {
        await conn.execute('CREATE INDEX idx_albums_department ON albums(department)');
      } catch (e: any) {
        if (e.errno !== 1061) throw e;
      }
    },
  },
  {
    // Hourly radio grid: one row per (day, hour), unique on the pair. Seeded
    // idempotently from the lineup that used to be hardcoded in the frontend
    // RadioSchedule component, so existing installs keep showing today's
    // programming until an admin edits it — fresh installs start from the
    // same baseline.
    name: '016_create_radio_schedule',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS radio_schedule (
          id VARCHAR(36) PRIMARY KEY,
          day ENUM('Mon','Tue','Wed','Thu','Fri','Sat','Sun') NOT NULL,
          hour TINYINT UNSIGNED NOT NULL,
          title VARCHAR(255) NOT NULL,
          host VARCHAR(255) NULL,
          category ENUM('worship','teaching','talk','music','live') NOT NULL DEFAULT 'talk',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY uq_radio_day_hour (day, hour)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      for (const [day, hour, title, host, category] of SEED_RADIO_SCHEDULE) {
        await conn.execute(
          'INSERT IGNORE INTO radio_schedule (id, day, hour, title, host, category) VALUES (UUID(), ?, ?, ?, ?, ?)',
          [day, hour, title, host, category]
        );
      }
    },
  },
  {
    // Shortwave broadcast schedule: one row per scheduled transmission (a
    // frequency beamed at a region at a time of day), unlike the hourly
    // `radio_schedule` grid, which is addressed by slot. `sort_order` gives
    // admins explicit control over the listing order.
    name: '017_create_shortwave_schedule',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS shortwave_schedule (
          id VARCHAR(36) PRIMARY KEY,
          start_time TIME NOT NULL,
          end_time TIME NULL,
          frequency_khz INT UNSIGNED NOT NULL,
          language VARCHAR(64) NULL,
          target VARCHAR(255) NULL,
          program VARCHAR(255) NULL,
          active TINYINT(1) NOT NULL DEFAULT 1,
          sort_order INT NOT NULL DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
    },
  },
  {
    name: '018_add_editor_role',
    up: async (conn) => {
      await conn.execute(
        "ALTER TABLE users MODIFY COLUMN role ENUM('super_admin','admin','editor') NOT NULL"
      );
    },
  },
  {
    // Admin-controlled display order for the programme library, so the covers
    // can be arranged deliberately instead of by upload date. Existing rows are
    // numbered newest-first, which is exactly how the library was ordered
    // before, so the first run does not reshuffle anything. Only rows still at
    // 0 are numbered, which keeps a partially-applied install idempotent.
    name: '019_add_programs_sort_order',
    up: async (conn) => {
      try {
        await conn.execute(
          'ALTER TABLE programs ADD COLUMN sort_order INT NOT NULL DEFAULT 0 AFTER cover_image'
        );
      } catch (e: any) {
        // 1060 = duplicate column: an earlier run already added it.
        if (e.errno !== 1060 && e.errno !== 1061) throw e;
      }
      await conn.execute(`
        UPDATE programs p
        JOIN (
          SELECT id, ROW_NUMBER() OVER (ORDER BY created_at DESC) AS rn
          FROM programs
        ) ranked ON ranked.id = p.id
        SET p.sort_order = ranked.rn
        WHERE p.sort_order = 0
      `);
    },
  },
  {
    // Optional section label inside a program ("Matthew", "Genesis", …). Tracks
    // with no label keep group_order 0 so they render first; every named group
    // gets the next order when its first track is created. Both columns are
    // nullable/defaulted, so existing rows need no backfill.
    name: '020_add_tracks_group',
    up: async (conn) => {
      try {
        await conn.execute(
          'ALTER TABLE tracks ADD COLUMN group_name VARCHAR(120) NULL AFTER track_type'
        );
      } catch (e: any) {
        // 1060 = duplicate column: an earlier run already added it.
        if (e.errno !== 1060) throw e;
      }
      try {
        await conn.execute(
          'ALTER TABLE tracks ADD COLUMN group_order INT NOT NULL DEFAULT 0 AFTER group_name'
        );
      } catch (e: any) {
        if (e.errno !== 1060) throw e;
      }
      try {
        await conn.execute(
          'CREATE INDEX idx_tracks_group ON tracks(program_id, group_order, sort_order)'
        );
      } catch (e: any) {
        // 1061 = duplicate key name, i.e. the index already exists.
        if (e.errno !== 1061) throw e;
      }
    },
  },
  {
    name: '021_create_chatbot_tables',
    up: async (conn) => {
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS chatbot_intents (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          name VARCHAR(100) NOT NULL UNIQUE,
          description TEXT NULL,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS chatbot_knowledge (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          intent_id VARCHAR(36) NULL,
          language ENUM('en','am','om') NOT NULL,
          question VARCHAR(500) NOT NULL,
          alternative_questions TEXT NULL,
          keywords TEXT NULL,
          answer MEDIUMTEXT NOT NULL,
          priority INT NOT NULL DEFAULT 0,
          is_active TINYINT(1) NOT NULL DEFAULT 1,
          source_type ENUM('manual','content_sync') NOT NULL DEFAULT 'manual',
          source_table VARCHAR(64) NULL,
          source_id VARCHAR(36) NULL,
          source_url VARCHAR(500) NULL,
          content_version VARCHAR(191) NULL,
          sync_status ENUM('approved','pending','rejected') NOT NULL DEFAULT 'approved',
          reviewed_by VARCHAR(36) NULL,
          approved_at TIMESTAMP NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_chat_knowledge_lang (language, is_active, sync_status, priority),
          KEY idx_chat_knowledge_intent (intent_id),
          KEY idx_chat_knowledge_source (source_type, source_table, source_id),
          CONSTRAINT fk_chat_knowledge_intent FOREIGN KEY (intent_id) REFERENCES chatbot_intents(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS chatbot_conversations (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          session_id VARCHAR(191) NOT NULL,
          language ENUM('en','am','om') NOT NULL DEFAULT 'en',
          context_intent_id VARCHAR(36) NULL,
          context_data TEXT NULL,
          started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          last_activity TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          KEY idx_chat_conv_session (session_id, last_activity),
          KEY idx_chat_conv_activity (last_activity)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS chatbot_messages (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          conversation_id VARCHAR(36) NOT NULL,
          sender ENUM('visitor','bot') NOT NULL,
          message MEDIUMTEXT NOT NULL,
          matched_knowledge_id VARCHAR(36) NULL,
          confidence_score DECIMAL(5,4) NULL,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          KEY idx_chat_msg_conversation (conversation_id, created_at),
          KEY idx_chat_msg_sender (sender, created_at),
          CONSTRAINT fk_chat_msg_conversation FOREIGN KEY (conversation_id) REFERENCES chatbot_conversations(id) ON DELETE CASCADE,
          CONSTRAINT fk_chat_msg_knowledge FOREIGN KEY (matched_knowledge_id) REFERENCES chatbot_knowledge(id) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS chatbot_settings (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          setting_key VARCHAR(100) NOT NULL UNIQUE,
          setting_value TEXT NOT NULL,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      await conn.execute(`
        CREATE TABLE IF NOT EXISTS chatbot_content_sources (
          id VARCHAR(36) NOT NULL PRIMARY KEY,
          source_table VARCHAR(64) NOT NULL,
          source_id VARCHAR(36) NOT NULL,
          language ENUM('en','am','om') NOT NULL DEFAULT 'en',
          content_version VARCHAR(191) NOT NULL,
          status ENUM('synced','pending','failed','removed') NOT NULL DEFAULT 'synced',
          last_error TEXT NULL,
          last_synced_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY uq_chat_source (source_table, source_id, language),
          KEY idx_chat_source_status (status, last_synced_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
    },
  },
  {
    name: '022_seed_chatbot_defaults',
    up: async (conn) => {
      const settings: Array<[string, string]> = [
        ['confidence_threshold', '0.38'],
        ['fuzzy_threshold', '0.42'],
        ['welcome_messages', JSON.stringify({
          en: 'Welcome! Ask me about our ministry, programmes, media library or how to contact us.',
          am: 'እንኳን ደህና መጡ! ስለ አገልግሎታችን፣ ፕሮግራሞች፣ የሚዲያ ቤተ-መጽሐፍት ወይም ስለ ማነጋገሪያችን ሊጠይቁኝ ይችላሉ።',
          om: 'Baga nagaan dhuftan! Waa\'ee tajaajila keenyaa waan barbaaddan gaafadhaa.',
        })],
        ['fallback_messages', JSON.stringify({
          en: "I couldn't find a reliable answer for that. Try asking about our programmes, media library, contact details or recent news, or contact us directly.",
          am: 'ለዚህ ጥያቄ አስተማማኝ መልስ አላገኘሁም። ስለ ፕሮግራሞች፣ የሚዲያ ቤተ-መጽሐፍት፣ የመገናኛ መረጃ ወይም ስለ ዜናዎች ይጠይቁ፣ ወይም በቀጥታ ያነጋግሩን።',
          om: 'Deebii amanamaa gaaffii kanaaf hin argattelle. Sagantaa, kuusaa miidiyaa, oduu dhihoo ykn hariiroo gaafadhaa, ykn kallattiin nu qaba.',
        })],
        ['enabled_languages', JSON.stringify(['en', 'am', 'om'])],
        ['auto_approve_content', 'true'],
        ['sync_interval_minutes', '10'],
        ['max_history_turns', '8'],
      ];
      for (const [key, value] of settings) {
        await conn.execute(
          'INSERT IGNORE INTO chatbot_settings (id, setting_key, setting_value) VALUES (?, ?, ?)',
          [`chat-setting-${key}`, key, value]
        );
      }

      const intents: Array<[string, string]> = [
        ['about', 'Who we are, mission and vision'],
        ['mission', 'Our mission and purpose'],
        ['contact', 'Contact details and address'],
        ['programs', 'Radio programmes and schedules'],
        ['media', 'Audio and photo media library'],
        ['services', 'What the organisation offers'],
        ['history', 'Our history and founding'],
        ['departments', 'Divisions and departments'],
        ['partnerships', 'Partnership and volunteering'],
        ['faq', 'Frequently asked questions'],
        ['news', 'Announcements and blog articles'],
        ['events', 'Upcoming events'],
        ['greeting', 'Greetings and small talk'],
      ];
      for (const [name, description] of intents) {
        await conn.execute(
          `INSERT IGNORE INTO chatbot_intents (id, name, description, is_active) VALUES (?, ?, ?, 1)`,
          [`chat-intent-${name}`, name, description]
        );
      }

      type Seed = {
        intent: string;
        priority: number;
        en: [string, string[], string[], string];
        am: [string, string[], string[], string];
        om: [string, string[], string[], string];
      };
      const seeds: Seed[] = [
        {
          intent: 'greeting', priority: 88,
          en: ['Hi', ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'greetings'], ['hi', 'hello', 'hey', 'greeting', 'morning', 'afternoon', 'evening'], 'Hi! Welcome to Yemisrach Dimts. Ask me about our programmes, media library, events, contact details or how to contact us.'],
          am: ['ሰላም', ['ሰላም', 'ጤና ይስጥልኝ', 'እንዴት ናችሁ?', 'እንደምን አደረክ'], ['ሰላም', 'ጤና', 'እንዴት'], 'እንኳን ደህና መጡ! ስለ ፕሮግራሞቻችን፣ የሚዲያ ቤተ-መጽሐፍት፣ ዝግጅቶች ወይም ስለ ማነጋገሪያችን ሊጠይቁኝ ይችላሉ።'],
          om: ['Baga nagaan', ['baga nagaan', 'baga nagaan dhuftan', 'asabuu', 'akkam jirtuu', 'akkam jirtan'], ['baga', 'nagaan', 'asabuu', 'akkam'], 'Baga nagaan dhuftan! Sagantaa keenyaa, kuusaa miidiyaa, sagantaalee ykn hariiroo gaafadhaa.'],
        },
        {
          intent: 'about', priority: 90,
          en: ['What is Yemisrach Dimts?', ['who are you', 'tell me about the organisation', 'about the ministry', 'what is your mission?', 'what is your vision?', 'mission and vision of ydcs'], ['yemisrach', 'dimts', 'organisation', 'ministry', 'mission', 'vision'], 'Yemisrach Dimts Communication Service is an Ethiopian Christian media ministry sharing the Gospel through radio, music, literature, television and online media. Our mission is to share the Gospel through media; our vision is to see lives transformed by the Word of God.'],
          am: ['የምሥራች ድምጽ ማን ነው?', ['ስለ እናንተ ንገሩኝ', 'ስለ ድርጅቱ', 'አገልግሎታችሁ', 'የራዕይዎ ምንድን ነው?', 'የተልእኮዎ ምንድን ነው?'], ['ምሥራች', 'ድምጽ', 'ድርጅት', 'አገልግሎት', 'ራዕይ', 'ተልእኮ'], 'የምሥራች ድምጽ አገልግሎት (YDCS) የኢትዮጵያ ቀዳሚ ክርስቲያናዊ ሚዲያ አገልግሎት ሲሆን ከ1960ዎቹ ጀምሮ በሬዲዮ፣ በሙዚቃ፣ በሥነ-ጽሑፍ እና በሚዲያ ምርት ወንጌልን ያሰራጫል። ተልዕኮአችን የኢየሱስ ክርስቶስን ወንጌል በተለያዩ የሚዲያ ቅጽበቶች ለመስበክ ነው፣  ምንም እንኳ በልዩ ልዩ ተግዳሮቶች ውስጥ ቢያልፍም አገልግሎቱ ግን እስካሁን ቀጥሏል፡፡።'],
          om: ['Sagaleen Missirachoo maalidha?', ['waan isanii', 'dhaabbata keenya', 'tajaajila keenya', 'Yaanni keessan maalidha?', 'who is sagalee missirachoo', 'sagalee missirachoo', 'sagalee misirachoo'], ['sagalee', 'missirachoo', 'dhaabbata', 'tajaajila', 'yaa'], 'Tajaajila Sagalee Misirachoo (YDCS), kan Sagalee Wangeelaa Itoophiyaa jedhamuun beekamu, Itoophiyaa keessatti tajaajila miidiyaa Kiristaanaa keessatti adda dureen kan hojjechaa jiru dha. YDCS jalqaba bara 1960moota irraa eegalee, raadiyoo, faarfannaa, barruulee fi oomishaalee miidiyaa gara garaatiin Wangeela labsaa tureera., Ergamni keenya Wangeela Yesuus Kiristoos karaa miidiyaa fi qunnamtii gara garaatiin labsuu fi namoota biraan gaʼuu dha. Qormaataalee seenaa keessatti mudatan hedduu keessa darbus, tajaajila Wangeelaa keenya amanamummaadhaan itti fufnee hojjechaa jira.'],
        },
        {
          intent: 'contact', priority: 95,
          en: ['How can I contact you?', ['contact information', 'phone number', 'email address', 'where are you'], ['contact', 'phone', 'email', 'address'], 'You can reach us through the Contact page on this website, by email at info@yemisrachdimts.org, or by phone at +251 11 321 0134. Our office is in Addis Ababa, Ethiopia.'],
          am: ['እንዴት ልናገኝዎት እችላለሁ?', ['የመገናኛ መረጃ', 'ስልክ ቁጥር', 'ኢሜይል አድራሻ'], ['ስልክ', 'ኢሜይል', 'አድራሻ', 'ማነጋገሪያ'], 'በዚህ ድረ-ገጽ የማነጋገሪያ ገጽ፣ በኢሜይል info@yemisrachdimts.org ወይም በስልክ +251 11 321 0134 ልታገኙን ትችላላችሁ። መሥሪያ ቤታችን በአዲስ አበባ፣ ኢትዮጵያ ነው።'],
          om: ['Akkamitti isin qunnamuun danda\'aa?', ['odeeffannoo hariiroo', 'lakkoofsa bilbilaa', 'imeelii', 'Akkanatti isan qaba\'uun danda\'a?'], ['bilbilaa', 'imeelii', 'adiressii', 'hariiroo'], 'Fuula hariiroo website keenyaa, imeelii info@yemisrachdimts.org ykn bilbila +251 11 321 0134 tiin nu qunnamuu dandeessu. Waajjirreen keenya Addis Ababa, Itoophiyaa keessa jira.'],
        },
        {
          intent: 'programs', priority: 88,
          en: ['What radio programmes do you have?', ['list of shows', 'programme schedule', 'what is on the radio'], ['programme', 'radio', 'schedule', 'show'], 'Our programmes include daily devotionals, Bible teaching, music, talk shows and live broadcasts. Browse the Programmes page for the current list, or the schedule page for the weekly timetable.'],
          am: ['ምን ፕሮግራሞች አሉዎት?', ['የፕሮግራም ዝርዝር', 'የሬዲዮ መርሃ ግብር'], ['ፕሮግራም', 'ሬዲዮ', 'መርሃ', 'ግብር'], 'ፕሮግራሞቻችን ዕለታዊ መንፈሳዊ ትምህርቶች፣ የመጽሐፍ ቅዱስ ትምህርት፣ ሙዚቃ፣ ውይይቶችና ቀጥታ ስርጭቶችን ያካትታሉ። ዝርዝሩን በፕሮግራሞች ገጽ፣ ሳምንታዊውን መርሃ ግብር ደግሞ በመርሃ ግብር ገጽ ማየት ይችላሉ።'],
          om: ['Sagantaa raadiyoo maal qabdu?', ['taraa sagantaa', 'jeecha torbanii', 'sagantaalee keenya', 'fuula Sagantaalee', 'fuula Sagantaa'], ['sagantaa', 'raadiyoo', 'jeecha', 'torban', 'sagantaalee', 'waaqeffannaa', 'macaafa', 'qulqulluu', 'faarfannaa', 'marii', 'tamsaasa'], 'Sagantaawwan keenya sagantaalee waaqeffannaa guyyaa guyyaa, barsiisa Macaafa Qulqulluu, faarfannaa, marii fi tamsaasa kallattiin of keessatti qabatu. Tarree sagantaalee yeroo ammaa ilaaluuf fuula Sagantaalee (Programmes) daawwadhaa; sagantaa torban keessaa ilaaluuf immoo fuula Sagantaa (Schedule) daawwadhaa.'],
        },
        {
          intent: 'media', priority: 85,
          en: ['Where can I listen or download media?', ['media library', 'audio archive', 'photos', 'sermons', 'where can I listen?', 'listen to our programs', 'listen online', 'listen.yemisrachdimts.org'], ['media', 'audio', 'download', 'photo', 'archive', 'listen', 'programme', 'homepage', 'yemisrachdimts', 'org', 'online'], 'click on listen our program button on our homepage or you can listen on listen.yemisrachdimts.org'],
          am: ['ሚዲያውን የት ማዳመጥ ወይም ማውረድ እችላለሁ?', ['የሚዲያ ቤተ-መጽሐፍት', 'የድምጽ ማህደር', 'ፎቶዎች', 'የት ማዳመጥ እችላለሁ?', 'በመነሻ ገጽ ላይ ማዳመጥ', 'አሁን ያዳምጡ', 'listen.yemisrachdimts.org'], ['ሚዲያ', 'ድምጽ', 'ማውረድ', 'ፎቶ', 'ማዳመጥ', 'መነሻ', 'ገጽ', 'listen', 'program', 'yemisrachdimts', 'org'], 'በመነሻ ገጻችን ላይ "አሁን ያዳምጡ" የሚለውን ቁልፍ ጠቅ ያድርጉ፣ ወይም በ listen.yemisrachdimts.org ላይ ማዳመጥ ይችላሉ።'],
          om: ['Miidiyaa eessaa dhaggeeffadhaa ykn buufadhaa?', ['kuusaa miidiyaa', 'suuraalee', 'dubbisa', 'eessaa dhaggeeffachuu?', 'Fuula jalqabaa irratti dhaggeeffachuu', 'Sagantaa Keenya Dhaaggefadhaa', 'listen.yemisrachdimts.org'], ['miidiyaa', 'dhaggeeffachuu', 'buufachuu', 'suuraa', 'listen', 'program', 'fuula', 'jalqabaa', 'yemisrachdimts', 'org'], 'Fuula jalqabaa irratti button  Sagantaa Keenya Dhaaggefadhaa jedhu irratti cuqaasa. ykn listen.yemisrachdimts.org jedhu seenuun dhaggeefadhaa.'],
        },
        {
          intent: 'services', priority: 80,
          en: ['What services do you offer?', ['your services', 'what do you do'], ['services', 'offer', 'media', 'publishing'], 'We produce radio and television programmes, music and devotionals, printed literature and books, and digital media. We also support churches and organisations through media training and partnerships.'],
          am: ['ምን አገልግሎቶች አሉዎት?', ['የአገልግሎቶችዎ ዝርዝር', 'ምን ይሰራሉ'], ['አገልግሎት', 'ማተሚያ', 'ሬዲዮ', 'ቴሌቪዥን'], 'የሬዲዮና የቴሌቪዥን ፕሮግራሞች፣ ሙዚቃና መንፈሳዊ ትምህርቶች፣ የታተሙ መጻሕፍትና ዲጂታል ሚዲያ እናመርታለን። ለአብያተ ክርስቲያናትም በስልጠናና በአጋርነት እንደግፋለን።'],
          om: ['Tajaajila maalii dhiyeessitu?', ['tajaajila keenya', 'maaltu hojjetama'], ['tajaajila', 'raadiyoo', 'TV', 'barruu'], 'Raadiyoo fi TV sagantaa, muuziqaa, barruu fi miidiyaa dijitaalaa qopheessina. Kaleessota fi dhaabbatawwaa, darbii fi michummaatiin gargaara.'],
        },
        {
          intent: 'history', priority: 84,
          en: [HISTORY_ANSWERS.en.question, HISTORY_ANSWERS.en.alternatives, HISTORY_ANSWERS.en.keywords, HISTORY_ANSWERS.en.answer],
          am: [HISTORY_ANSWERS.am.question, HISTORY_ANSWERS.am.alternatives, HISTORY_ANSWERS.am.keywords, HISTORY_ANSWERS.am.answer],
          om: [HISTORY_ANSWERS.om.question, HISTORY_ANSWERS.om.alternatives, HISTORY_ANSWERS.om.keywords, HISTORY_ANSWERS.om.answer],
        },
        {
          intent: 'departments', priority: 75,
          en: ['What departments do you have?', ['divisions', 'teams'], ['department', 'division', 'team', 'electronic', 'print', 'finance'], 'Our work is organised into departments including electronic media, print and publishing, finance and administration, resource and archive, and leadership. Visit the Divisions and Leadership pages for details.'],
          am: ['ምን ክፍሎች አሉዎት?', ['ክፍሎች', 'ቡድኖች'], ['ክፍል', 'ኤሌክትሮኒክ', 'ማተሚያ', 'ፋይናንስ'], 'ሥራችን በኤሌክትሮኒክ ሚዲያ፣ በማተሚያና ሥነ ጽሑፍ፣ በፋይናንስና አስተዳደር፣ በሀብትና ማህደር፣ እንዲሁም በአመራር ክፍሎች ተደራጅቷል።'],
          om: ['Kutaa maalii qabdu?', ['qoodama', 'gareewwan'], ['kutaa', 'elektiroonikii', 'maxxansa', 'finansii'], 'Hojii keenya kutaa miidiyaa elektiroonikii, maxxansaa fi barruu, finansii fi bulchiinsa, kuusaa fi deeggarsaatiin qophaayeera.'],
        },
        {
          intent: 'partnerships', priority: 72,
          en: ['How can we partner with you?', ['volunteer', 'support your ministry', 'donate'], ['partner', 'volunteer', 'support', 'donate'], 'We welcome partnerships with churches, Christians and organisations that share our mission. Please use the Contact page or email info@yemisrachdimts.org to discuss partnership, volunteering or support.'],
          am: ['እንዴት ከእናንተ ጋር አጋርነት ልንመሥርት እንችላለን?', ['በጃንታ መሳተፍ', 'ድጋፍ', 'መለገስ'], ['አጋርነት', 'በጃንታ', 'ድጋፍ', 'መለገስ'], 'ከእኛ ጋር ተመሳሳይ ተልዕኮ ካላቸው አብያተ ክርስቲያናት፣ ክርስቲያኖችና ድርጅቶች ጋር አጋርነትን እንቀበላለን። በማነጋገሪያ ገጽ ወይም info@yemisrachdimts.org በኢሜይል ያነጋግሩን።'],
          om: ['Akkaatam isan waliin michummaa uumu dandeenya?', ['gargaarsa', 'kallattii darbii'], ['michummaa', 'gargaarsa', 'deeggarsa'], 'Kaleessota fi dhaabbatawwaa wangeela jaallatan waliin michummaa ni deeggarra. Fuula hariiroo ykn imeelii info@yemisrachdimts.org tiin nu qaba.'],
        },
        {
          intent: 'faq', priority: 60,
          en: ['Do you have a mobile app?', ['can I listen offline', 'is it free'], ['app', 'mobile', 'free', 'offline'], 'You can listen on this website on desktop and mobile. The player works in your browser without installing a separate app, and there is no subscription fee.'],
          am: ['የሞባይል መተግበሪያ አላችሁ?', ['ከመስመር ውጭ ማዳመጥ', 'ነፃ ነው?'], ['መተግበሪያ', 'ሞባይል', 'ነፃ'], 'በዚህ ድረ-ገጽ በኮምፒውተርም ሆነ በሞባይል ማዳመጥ ይችላሉ። ማጫወቻው በአሳሽዎ ውስጥ የሚሰራ ሲሆን ምንም የደንበኝነት ክፍያ የለም።'],
          om: ['App mobile qabduu?', ['offline dhaggeeffachuu', 'free dhaa?'], ['app', 'mobile', 'free'], 'Website kana irraa bilbila fi kompiutara irratti dhaggeeffattu. Application addaa hin barbaadu, kaffaltii memberii hin qabdu.'],
        },
        {
          intent: 'news', priority: 78,
          en: ['What is new on the website?', ['latest news', 'blog articles', 'announcements'], ['news', 'blog', 'announcement', 'latest'], 'The Latest and Blog pages carry our newest announcements, articles and updates. Open the notification bell or the News & Blog page to read them.'],
          am: ['በድረ-ገጹ ላይ ምን አዲስ ነው?', ['የቅርብ ዜና', 'ጽሑፎች', 'ማስታወቂያዎች'], ['ዜና', 'ጽሑፍ', 'ማስታወቂያ', 'አዲስ'], 'የቅርብ ማስታወቂያዎችን፣ ጽሑፎችንና ዝመናዎችን በአዲስ ነገርና በጽሑፎች ገጾች ማግኘት ይችላሉ።'],
          om: ['Website irratti maal haaraa jira?', ['oduu dhihoo', 'barruulee'], ['haaraa', 'oduu', 'barruu', 'beeksisaa'], 'Beeksisaa fi barruulee haaraa fuula Oduu fi Barruu irraa dubbisu dandeessu.'],
        },
        {
          intent: 'events', priority: 76,
          en: ['What events are coming up?', ['upcoming events', 'when is the next event', 'tell me events'], ['event', 'upcoming', 'date', 'conference'], 'Ask me "tell me events" and I will list the next scheduled events with their dates and locations.'],
          am: ['ምን ዝግጅቶች ናቸው የሚመጡ?', ['የሚመጡ ዝግጅቶች', 'ቀጣይ ዝግጅት'], ['ዝግጅት', 'ቀን', 'ቦታ'], 'የሚመጡ ዝግጅቶች በመነሻ ገጽና በዝግጅቶች ክፍል ይታያሉ። ቀኑን፣ ቦታውንና መግለጫውን እዚያ ያገኛሉ።'],
          om: ['Sagantaalee itti aanee maal jiru?', ['sagantaa dhufu', 'yeroo itti aanu'], ['sagantaa', 'guyyaa', 'bakka'], 'Sagantaalee itti aanan fuula duraa fi kutaa sagantaa irraa argattu; guyyaa fi bakka isanii achii ilaali.'],
        },
      ];

      for (const seed of seeds) {
        for (const lang of ['en', 'am', 'om'] as const) {
          const [question, alternatives, keywords, answer] = seed[lang];
          if (!question || !answer) continue;
          await conn.execute(
            `INSERT IGNORE INTO chatbot_knowledge
              (id, intent_id, language, question, alternative_questions, keywords, answer, priority, is_active, source_type, sync_status, approved_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual', 'approved', CURRENT_TIMESTAMP)`,
            [
              `chat-kb-${seed.intent}-${lang}`,
              `chat-intent-${seed.intent}`,
              lang,
              question,
              JSON.stringify(alternatives),
              JSON.stringify(keywords),
              answer,
              seed.priority,
            ]
          );
        }
      }
    },
  },
  {
    name: '023_improve_chatbot_program_matching',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET alternative_questions = ?, keywords = ?, answer = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-programs-en' AND source_type = 'manual'`,
        [
          JSON.stringify([
            'list of shows',
            'programme schedule',
            'what is on the radio',
            'how do I get your program?',
            'how can I access your programmes?',
            'where can I find your programmes?',
            'how do I listen to your programmes?',
            'do you have a program?',
          ]),
          JSON.stringify(['programme', 'program', 'radio', 'schedule', 'show', 'listen', 'access']),
          'Our programmes include daily devotionals, Bible teaching, music, talk shows and live broadcasts. Browse the Programmes page for the current list, or the schedule page for the weekly timetable. You can listen on this website or in the player without installing anything.',
        ]
      );
    },
  },
  {
    name: '024_improve_chatbot_mission_vision_matching',
    up: async (conn) => {
      const updates: Array<[string, string, string, string]> = [
        [
          'chat-kb-about-en',
          JSON.stringify([
            'who are you',
            'tell me about the organisation',
            'about the ministry',
            'what is your mission?',
            'what is your vision?',
            'mission and vision of ydcs',
          ]),
          JSON.stringify(['yemisrach', 'dimts', 'organisation', 'ministry', 'mission', 'vision']),
          'Yemisrach Dimts Communication Service is an Ethiopian Christian media ministry sharing the Gospel through radio, music, literature, television and online media. Our mission is to share the Gospel through media; our vision is to see lives transformed by the Word of God.',
        ],
        [
          'chat-kb-about-am',
          JSON.stringify(['ስለ እናንተ ንገሩኝ', 'ስለ ድርጅቱ', 'አገልግሎታችሁ', 'የራዕይዎ ምንድን ነው?', 'የተልእኮዎ ምንድን ነው?']),
          JSON.stringify(['ምሥራች', 'ድምጽ', 'ድርጅት', 'አገልግሎት', 'ራዕይ', 'ተልእኮ']),
          'የምሥራች ድምጽ አገልግሎት (YDCS) የኢትዮጵያ ቀዳሚ ክርስቲያናዊ ሚዲያ አገልግሎት ሲሆን ከ1960ዎቹ ጀምሮ በሬዲዮ፣ በሙዚቃ፣ በሥነ-ጽሑፍ እና በሚዲያ ምርት ወንጌልን ያሰራጫል። ተልዕኮአችን የኢየሱስ ክርስቶስን ወንጌል በተለያዩ የሚዲያ ቅጽበቶች ለመስበክ ነው፣  ምንም እንኳ በልዩ ልዩ ተግዳሮቶች ውስጥ ቢያልፍም አገልግሎቱ ግን እስካሁን ቀጥሏል፡፡።',
        ],
        [
          'chat-kb-about-om',
          JSON.stringify(['waan isanii', 'dhaabbata keenya', 'tajaajila keenya', 'Yaanni keessan maalidha?', "Ergamni keessan maalidha?"]),
          JSON.stringify(['sagalee', 'missirachoo', 'dhaabbata', 'tajaajila', 'yaa', 'ergama']),
          'Sagaleen Missirachoo tajaajila miidiyaa Kiristaanaa Itoophiyaati. Ergamni keenya Wangeela karaa raadiyoo, muuziqaa, barruu, TV fi interneetii labsuu dha; yaanni keenya immoo jireenyi dubbii Waaqaa keenya jijjiiramuudha.',
        ],
      ];

      for (const [id, alternatives, keywords, answer] of updates) {
        await conn.execute(
          `UPDATE chatbot_knowledge
              SET alternative_questions = ?, keywords = ?, answer = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND source_type = 'manual'`,
          [alternatives, keywords, answer, id]
        );
      }
    },
  },
  {
    name: '025_replace_oromo_about_answer',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET alternative_questions = ?, keywords = ?, answer = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-about-om' AND source_type = 'manual'`,
        [
          JSON.stringify([
            'waan isanii',
            'dhaabbata keenya',
            'tajaajila keenya',
            'Yaanni keessan maalidha?',
            'Ergamni keessan maalidha?',
            'who is sagalee missirachoo',
            'sagalee missirachoo',
            'sagalee misirachoo',
          ]),
          JSON.stringify(['sagalee', 'missirachoo', 'dhaabbata', 'tajaajila', 'yaa', 'ergama']),
          'Tajaajila Sagalee Misirachoo (YDCS), kan Sagalee Wangeelaa Itoophiyaa jedhamuun beekamu, Itoophiyaa keessatti tajaajila miidiyaa Kiristaanaa keessatti adda dureen kan hojjechaa jiru dha. YDCS jalqaba bara 1960moota irraa eegalee, raadiyoo, faarfannaa, barruulee fi oomishaalee miidiyaa gara garaatiin Wangeela labsaa tureera., Ergamni keenya Wangeela Yesuus Kiristoos karaa miidiyaa fi qunnamtii gara garaatiin labsuu fi namoota biraan gaʼuu dha. Qormaataalee seenaa keessatti mudatan hedduu keessa darbus, tajaajila Wangeelaa keenya amanamummaadhaan itti fufnee hojjechaa jira.',
        ]
      );
    },
  },
  {
    name: '026_replace_oromo_mission_answer',
    up: async (conn) => {
      await conn.execute(
        `INSERT IGNORE INTO chatbot_intents (id, name, description, is_active) VALUES (?, ?, ?, 1)`,
        ['chat-intent-mission', 'mission', 'Our mission and purpose']
      );

      await conn.execute(
        `INSERT INTO chatbot_knowledge
          (id, intent_id, language, question, alternative_questions, keywords, answer, priority, is_active,
           source_type, sync_status, approved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual', 'approved', CURRENT_TIMESTAMP)
         ON DUPLICATE KEY UPDATE
           question = VALUES(question), intent_id = VALUES(intent_id),
           alternative_questions = VALUES(alternative_questions), keywords = VALUES(keywords),
           answer = VALUES(answer), priority = VALUES(priority), is_active = 1,
           sync_status = VALUES(sync_status), updated_at = CURRENT_TIMESTAMP`,
        [
          'chat-kb-mission-om',
          'chat-intent-mission',
          'om',
          'Ergamni Sagalee Misirachoo maalidha?',
          JSON.stringify([
            'ergamni keessan maalidha?',
            'ergama keessan maalidha?',
            'mission of ydcs',
            'what is your mission?',
            'what is the mission of sagalee missirachoo?',
            'ergama ydcs',
            'maaliif sagalee missirachoo jira?',
          ]),
          JSON.stringify([
            'ergama', 'ergamni', 'mission', 'wangeela', 'yesuus', 'kiristoos', 'miidiyaa',
            'ydcs', 'sagalee', 'missirachoo', 'namoota', 'biraan', 'gaʼuu',
          ]),
          'Wangeela Yesuus Kiristoos karaa miidiyaatiin labsuu fi namootaan gaʼuuf. YDCS qabiyyee Kiristaanaa oomishuu, waldoota kiristaanaa deeggaruu, kuusaa seenaa fi galmeewwan seenaa eegu, akkasumas meeshaalee qunnamtii ammayyaa fayyadamuun ergaa Yesuus Kiristoos namoota biraan gaʼuuf ergama isaa itti fufee raawwachaa jira.',
          96,
        ]
      );

      await conn.execute(
        `UPDATE chatbot_knowledge
            SET alternative_questions = ?, keywords = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-about-om' AND source_type = 'manual'`,
        [
          JSON.stringify([
            'waan isanii',
            'dhaabbata keenya',
            'tajaajila keenya',
            'Yaanni keessan maalidha?',
            'who is sagalee missirachoo',
            'sagalee missirachoo',
            'sagalee misirachoo',
          ]),
          JSON.stringify(['sagalee', 'missirachoo', 'dhaabbata', 'tajaajila', 'yaa']),
        ]
      );
    },
  },
  {
    name: '027_rename_oromo_contact_question',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET question = ?, alternative_questions = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-contact-om' AND source_type = 'manual'`,
        [
          'Akkamitti isin qunnamuun danda\'aa?',
          JSON.stringify([
            'odeeffannoo hariiroo',
            'lakkoofsa bilbilaa',
            'imeelii',
            'Akkanatti isan qaba\'uun danda\'a?',
          ]),
        ]
      );
    },
  },
  {
    name: '028_replace_english_media_answer',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET answer = ?, alternative_questions = ?, keywords = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-media-en' AND source_type = 'manual'`,
        [
          'click on listen our program button on our homepage or you can listen on listen.yemisrachdimts.org',
          JSON.stringify([
            'media library',
            'audio archive',
            'photos',
            'sermons',
            'where can I listen?',
            'listen to our programs',
            'listen online',
            'listen.yemisrachdimts.org',
          ]),
          JSON.stringify([
            'media', 'audio', 'download', 'photo', 'archive', 'listen', 'programme',
            'homepage', 'yemisrachdimts', 'org', 'online',
          ]),
        ]
      );
    },
  },
  {
    name: '029_replace_oromo_media_answer',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET answer = ?, alternative_questions = ?, keywords = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-media-om' AND source_type = 'manual'`,
        [
          'Fuula duraa keenya irraa "Listen our program" jedhamu cuquu dandeessu, ykn listen.yemisrachdimts.org irratti dhaggeeffachuu dandeessu.',
          JSON.stringify([
            'kuusaa miidiyaa',
            'suuraalee',
            'dubbisa',
            'eessaa dhaggeeffachuu?',
            'Fuula duraa irraa dhaggeeffachuu',
            'listen.yemisrachdimts.org',
          ]),
          JSON.stringify([
            'miidiyaa', 'dhaggeeffachuu', 'buufachuu', 'suuraa', 'listen', 'program',
            'fuula', 'duraa', 'yemisrachdimts', 'org',
          ]),
        ]
      );
    },
  },
  {
    name: '030_replace_oromo_programs_answer',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET answer = ?, alternative_questions = ?, keywords = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-programs-om' AND source_type = 'manual'`,
        [
          'Sagantaawwan keenya sagantaalee waaqeffannaa guyyaa guyyaa, barsiisa Macaafa Qulqulluu, faarfannaa, marii fi tamsaasa kallattiin of keessatti qabatu. Tarree sagantaalee yeroo ammaa ilaaluuf fuula Sagantaalee (Programmes) daawwadhaa; sagantaa torban keessaa ilaaluuf immoo fuula Sagantaa (Schedule) daawwadhaa.',
          JSON.stringify([
            'taraa sagantaa',
            'jeecha torbanii',
            'sagantaalee keenya',
            'fuula Sagantaalee',
            'fuula Sagantaa',
          ]),
          JSON.stringify([
            'sagantaa', 'raadiyoo', 'jeecha', 'torban', 'sagantaalee', 'waaqeffannaa',
            'macaafa', 'qulqulluu', 'faarfannaa', 'marii', 'tamsaasa',
          ]),
        ]
      );
    },
  },
  {
    name: '031_replace_amharic_media_answer',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET answer = ?, alternative_questions = ?, keywords = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-media-am' AND source_type = 'manual'`,
        [
          'በመነሻ ገጻችን ላይ "Listen our program" የሚለውን ቁልፍ ጠቅ ያድርጉ፣ ወይም በ listen.yemisrachdimts.org ላይ ማዳመጥ ይችላሉ።',
          JSON.stringify([
            'የሚዲያ ቤተ-መጽሐፍት',
            'የድምጽ ማህደር',
            'ፎቶዎች',
            'የት ማዳመጥ እችላለሁ?',
            'በመነሻ ገጽ ላይ ማዳመጥ',
            'listen.yemisrachdimts.org',
          ]),
          JSON.stringify([
            'ሚዲያ', 'ድምጽ', 'ማውረድ', 'ፎቶ', 'ማዳመጥ', 'መነሻ', 'ገጽ',
            'listen', 'program', 'yemisrachdimts', 'org',
          ]),
        ]
      );
    },
  },
  {
    name: '032_correct_localised_chatbot_text',
    up: async (conn) => {
      const settingsUpdates: Array<[string, string]> = [
        ['welcome_messages', JSON.stringify({
          en: 'Welcome! Ask me about our ministry, programmes, media library or how to contact us.',
          am: 'እንኳን ደህና መጡ! ስለ አገልግሎታችን፣ ፕሮግራሞች፣ የሚዲያ ቤተ-መጽሐፍት ወይም ስለ ማነጋገሪያችን ሊጠይቁኝ ይችላሉ።',
          om: 'Baga nagaan dhuftan! Waa\'ee tajaajila keenyaa waan barbaaddan gaafadhaa.',
        })],
        ['fallback_messages', JSON.stringify({
          en: "I couldn't find a reliable answer for that. Try asking about our programmes, media library, contact details or recent news, or contact us directly.",
          am: 'ለዚህ ጥያቄ አስተማማኝ መልስ አላገኘሁም። ስለ ፕሮግራሞች፣ የሚዲያ ቤተ-መጽሐፍት፣ የመገናኛ መረጃ ወይም ስለ ዜናዎች ይጠይቁ፣ ወይም በቀጥታ ያነጋግሩን።',
          om: 'Deebii amanamaa gaaffii kanaaf hin argattelle. Sagantaa, kuusaa miidiyaa, oduu dhihoo ykn hariiroo gaafadhaa, ykn kallattiin nu qaba.',
        })],
      ];
      for (const [key, value] of settingsUpdates) {
        await conn.execute(
          'UPDATE chatbot_settings SET setting_value = ?, updated_at = CURRENT_TIMESTAMP WHERE setting_key = ?',
          [value, key]
        );
      }

      const answerUpdates: Array<[string, string]> = [
        ['chat-kb-about-am', 'የምሥራች ድምጽ አገልግሎት (YDCS) የኢትዮጵያ ቀዳሚ ክርስቲያናዊ ሚዲያ አገልግሎት ሲሆን ከ1960ዎቹ ጀምሮ በሬዲዮ፣ በሙዚቃ፣ በሥነ-ጽሑፍ እና በሚዲያ ምርት ወንጌልን ያሰራጫል። ተልዕኮአችን የኢየሱስ ክርስቶስን ወንጌል በተለያዩ የሚዲያ ቅጽበቶች ለመስበክ ነው፣  ምንም እንኳ በልዩ ልዩ ተግዳሮቶች ውስጥ ቢያልፍም አገልግሎቱ ግን እስካሁን ቀጥሏል፡፡።'],
        ['chat-kb-contact-om', 'Fuula hariiroo website keenyaa, imeelii info@yemisrachdimts.org ykn bilbila +251 11 321 0134 tiin nu qunnamuu dandeessu. Waajjirreen keenya Addis Ababa, Itoophiyaa keessa jira.'],
        ['chat-kb-media-am', 'በመነሻ ገጻችን ላይ "Listen our program" የሚለውን ቁልፍ ጠቅ ያድርጉ፣ ወይም በ listen.yemisrachdimts.org ላይ ማዳመጥ ይችላሉ።'],
        ['chat-kb-media-om', 'Fuula duraa keenya irraa "Listen our program" jedhamu cuquu dandeessu, ykn listen.yemisrachdimts.org irratti dhaggeeffachuu dandeessu.'],
        ['chat-kb-services-om', 'Raadiyoo fi TV sagantaa, muuziqaa, barruu fi miidiyaa dijitaalaa qopheessina. Kaleessota fi dhaabbatawwaa, darbii fi michummaatiin gargaara.'],
        ['chat-kb-departments-om', 'Hojii keenya kutaa miidiyaa elektiroonikii, maxxansaa fi barruu, finansii fi bulchiinsa, kuusaa fi deeggarsaatiin qophaayeera.'],
        ['chat-kb-partnerships-om', 'Kaleessota fi dhaabbatawwaa wangeela jaallatan waliin michummaa ni deeggarra. Fuula hariiroo ykn imeelii info@yemisrachdimts.org tiin nu qaba.'],
      ];
      for (const [id, answer] of answerUpdates) {
        await conn.execute(
          'UPDATE chatbot_knowledge SET answer = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND source_type = ?',
          [answer, id, 'manual']
        );
      }
    },
  },
  {
    name: '033_use_localised_listen_button_labels',
    up: async (conn) => {
      const updates: Array<[string, string, string]> = [
        [
          'chat-kb-media-am',
          'በመነሻ ገጻችን ላይ "አሁን ያዳምጡ" የሚለውን ቁልፍ ጠቅ ያድርጉ፣ ወይም በ listen.yemisrachdimts.org ላይ ማዳመጥ ይችላሉ።',
          JSON.stringify(['አሁን ያዳምጡ', 'በመነሻ ገጽ ላይ ማዳመጥ', 'listen.yemisrachdimts.org']),
        ],
        [
          'chat-kb-media-om',
          'Fuula duraa keenya irratti "Amma Dhaggeeffadhaa" jedhamu cuquu dandeessu, ykn listen.yemisrachdimts.org irratti dhaggeeffachuu dandeessu.',
          JSON.stringify(['Amma Dhaggeeffadhaa', 'Fuula duraa irratti dhaggeeffachuu', 'listen.yemisrachdimts.org']),
        ],
      ];

      for (const [id, answer, alternatives] of updates) {
        await conn.execute(
          `UPDATE chatbot_knowledge
              SET answer = ?, alternative_questions = ?, updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND source_type = 'manual'`,
          [answer, alternatives, id]
        );
      }
    },
  },
  {
    name: '034_replace_oromo_media_answer_with_supported_wording',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET answer = ?, alternative_questions = ?, keywords = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-media-om' AND source_type = 'manual'`,
        [
          'Fuula jalqabaa irratti button  Sagantaa Keenya Dhaaggefadhaa jedhu irratti cuqaasa. ykn listen.yemisrachdimts.org jedhu seenuun dhaggeefadhaa.',
          JSON.stringify([
            'kuusaa miidiyaa',
            'suuraalee',
            'dubbisa',
            'eessaa dhaggeeffachuu?',
            'Fuula jalqabaa irratti dhaggeeffachuu',
            'Sagantaa Keenya Dhaaggefadhaa',
            'listen.yemisrachdimts.org',
          ]),
          JSON.stringify([
            'miidiyaa', 'dhaggeeffachuu', 'buufachuu', 'suuraa', 'listen', 'program',
            'fuula', 'jalqabaa', 'yemisrachdimts', 'org',
          ]),
        ]
      );
    },
  },
  {
    name: '035_change_oromo_program_answer_word',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET answer = ?, keywords = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-programs-om' AND source_type = 'manual'`,
        [
          'Sagantaawwan keenya sagantaalee waaqeffannaa guyyaa guyyaa, barsiisa Macaafa Qulqulluu, faarfannaa, marii fi tamsaasa kallattiin of keessatti qabatu. Tarree sagantaalee yeroo ammaa ilaaluuf fuula Sagantaalee (Programmes) daawwadhaa; sagantaa torban keessaa ilaaluuf immoo fuula Sagantaa (Schedule) daawwadhaa.',
          JSON.stringify([
            'sagantaa', 'raadiyoo', 'jeecha', 'torban', 'sagantaalee', 'waaqeffannaa',
            'macaafa', 'qulqulluu', 'faarfannaa', 'marii', 'tamsaasa',
          ]),
        ]
      );
    },
  },
  {
    name: '036_improve_events_answer',
    up: async (conn) => {
      await conn.execute(
        `UPDATE chatbot_knowledge
            SET answer = ?, alternative_questions = ?, priority = 70, updated_at = CURRENT_TIMESTAMP
          WHERE id = 'chat-kb-events-en' AND source_type = 'manual'`,
        [
          'Ask me "tell me events" and I will list the next scheduled events with their dates and locations.',
          JSON.stringify(['upcoming events', 'when is the next event', 'tell me events']),
        ]
      );
    },
  },
  {
    name: '037_add_greeting_answers',
    up: async (conn) => {
      await conn.execute(
        `INSERT IGNORE INTO chatbot_intents (id, name, description, is_active)
         VALUES ('chat-intent-greeting', 'greeting', 'Greetings and small talk', 1)`
      );

      const greetings: Array<[string, string, string[], string[], string]> = [
        ['en', 'Hi', ['hi', 'hello', 'hey', 'good morning', 'good afternoon', 'good evening', 'greetings'], ['hi', 'hello', 'hey', 'greeting', 'morning', 'afternoon', 'evening'], 'Hi! Welcome to Yemisrach Dimts. Ask me about our programmes, media library, events, contact details or how to contact us.'],
        ['am', 'ሰላም', ['ሰላም', 'ጤና ይስጥልኝ', 'እንዴት ናችሁ?', 'እንደምን አደረክ'], ['ሰላም', 'ጤና', 'እንዴት'], 'እንኳን ደህና መጡ! ስለ ፕሮግራሞቻችን፣ የሚዲያ ቤተ-መጽሐፍት፣ ዝግጅቶች ወይም ስለ ማነጋገሪያችን ሊጠይቁኝ ይችላሉ።'],
        ['om', 'Baga nagaan', ['baga nagaan', 'baga nagaan dhuftan', 'asabuu', 'akkam jirtuu', 'akkam jirtan'], ['baga', 'nagaan', 'asabuu', 'akkam'], 'Baga nagaan dhuftan! Sagantaa keenyaa, kuusaa miidiyaa, sagantaalee ykn hariiroo gaafadhaa.'],
      ];

      for (const [language, question, alternatives, keywords, answer] of greetings) {
        await conn.execute(
          `INSERT IGNORE INTO chatbot_knowledge
            (id, intent_id, language, question, alternative_questions, keywords, answer, priority, is_active, source_type, sync_status, approved_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'manual', 'approved', CURRENT_TIMESTAMP)`,
          [
            `chat-kb-greeting-${language}`,
            'chat-intent-greeting',
            language,
            question,
            JSON.stringify(alternatives),
            JSON.stringify(keywords),
            answer,
            88,
          ]
        );
      }
    },
  },
  {
    name: '038_replace_history_answers',
    up: async (conn) => {
      for (const [language, content] of Object.entries(HISTORY_ANSWERS)) {
        await conn.execute(
          `UPDATE chatbot_knowledge
              SET question = ?, alternative_questions = ?, keywords = ?, answer = ?, priority = 84,
                  updated_at = CURRENT_TIMESTAMP
            WHERE id = ? AND source_type = 'manual'`,
          [
            content.question,
            JSON.stringify(content.alternatives),
            JSON.stringify(content.keywords),
            content.answer,
            `chat-kb-history-${language}`,
          ]
        );
      }
    },
  },
];

/**
 * The lineup previously hardcoded as `SCHEDULE` in the frontend
 * `RadioSchedule`. Kept here so the first DB-backed render shows exactly what
 * visitors were used to; admins then edit the real rows.
 */
const SEED_RADIO_SCHEDULE: Array<[string, number, string, string | null, string]> = [];

// Nightly recurring block, every day, hours 0-4
for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const) {
  for (const [hour, title, host, category] of [
    [0, 'Midnight Prayer & Worship', 'Prayer Team', 'worship'],
    [1, 'GAZ_TTB – Oromo Bible Study', 'Oromo Team', 'teaching'],
    [2, 'Morning Devotion (AMH_TTB)', 'Amharic Team', 'teaching'],
    [3, 'SOM_TTB – Somali Bible Study', 'Somali Team', 'teaching'],
    [4, 'TIR_TW – Tigrinya Worship', 'Tigrinya Team', 'worship'],
  ] as Array<[number, string, string, string]>) {
    SEED_RADIO_SCHEDULE.push([day, hour, title, host, category]);
  }
}
// Day-specific evening programs, verbatim from the old static grid.
SEED_RADIO_SCHEDULE.push(
  ['Mon', 5, "Children's Bible Hour", 'Sis. Helen', 'talk'],
  ['Mon', 6, 'Evening Gospel Music', 'DJ Mark', 'music'],
  ['Mon', 7, 'Night Intercession', 'Prayer Team', 'live'],
  ['Tue', 5, 'Youth Talk', 'Bro. Yonas', 'talk'],
  ['Tue', 6, 'Live Worship Hour', 'Worship Team', 'live'],
  ['Tue', 7, 'Scripture Reflections', 'Pastor Daniel', 'teaching'],
  ['Wed', 5, 'Women of Faith', 'Mrs. Esther', 'talk'],
  ['Wed', 6, 'Testimony Time', 'Mr. Samuel', 'talk'],
  ['Wed', 7, 'Midweek Revival', 'Pastor Daniel', 'live'],
  ['Thu', 5, 'Community Matters', 'Mr. Samuel', 'talk'],
  ['Thu', 6, 'Acoustic Worship', 'Worship Team', 'live'],
  ['Thu', 7, 'Evening Scriptures', 'Bro. John', 'teaching'],
  ['Fri', 5, 'Men of Valor', 'Mr. Samuel', 'talk'],
  ['Fri', 6, 'Live Friday Revival', 'Worship Team', 'live'],
  ['Fri', 7, 'Night Vigil Broadcast', 'Pastor Daniel', 'worship'],
  ['Fri', 8, 'Night Vigil Broadcast', 'Pastor Daniel', 'worship'],
  ['Sat', 5, 'Saturday School', 'Mrs. Esther', 'teaching'],
  ['Sat', 6, 'Worship Night Preview', 'Worship Team', 'live'],
  ['Sat', 7, 'Late Night Gospel', 'DJ Mark', 'music'],
  ['Sun', 2, 'Pre-Service Worship', 'Worship Team', 'worship'],
  ['Sun', 3, 'Sunday Main Service', 'Pastor Daniel', 'live'],
  ['Sun', 4, 'Sunday School Replay', 'Mrs. Esther', 'teaching'],
  ['Sun', 5, 'Afternoon Praise', 'Sis. Grace', 'worship'],
  ['Sun', 6, 'Evening Thanksgiving', 'Pastor Daniel', 'live'],
  ['Sun', 7, 'Close of Day Prayers', 'Mr. Samuel', 'worship'],
);

const CREATE_INDEXES: Migration[] = [
  'CREATE INDEX idx_tracks_program ON tracks(program_id)',
  'CREATE INDEX idx_tracks_created ON tracks(created_at DESC)',
  'CREATE INDEX idx_tracks_sort ON tracks(program_id, sort_order)',
  'CREATE INDEX idx_tracks_type ON tracks(track_type)',
  'CREATE INDEX idx_programs_created ON programs(created_at DESC)',
  'CREATE INDEX idx_programs_creator ON programs(created_by)',
  'CREATE INDEX idx_programs_sort ON programs(sort_order, created_at DESC)',
  'CREATE INDEX idx_comments_program ON comments(program_id)',
  'CREATE INDEX idx_comments_created ON comments(created_at DESC)',
  'CREATE INDEX idx_likes_track ON likes(track_id)',
  'CREATE INDEX idx_likes_fingerprint ON likes(fingerprint)',
  'CREATE INDEX idx_users_role ON users(role)',
  'CREATE INDEX idx_listens_track ON listens(track_id)',
  'CREATE INDEX idx_listens_program ON listens(program_id)',
  'CREATE INDEX idx_listens_created ON listens(created_at DESC)',
  'CREATE INDEX idx_leaders_sort ON leaders(sort_order, created_at)',
  'CREATE INDEX idx_album_photos_album ON album_photos(album_id, sort_order)',
  'CREATE INDEX idx_announcements_feed ON announcements(pinned DESC, created_at DESC)',
  'CREATE INDEX idx_events_starts ON events(starts_at DESC)',
  'CREATE INDEX idx_blog_slug ON blog_posts(slug)',
  'CREATE INDEX idx_blog_created ON blog_posts(created_at DESC)',
  'CREATE INDEX idx_blog_published ON blog_posts(published, created_at DESC)',
  'CREATE INDEX idx_blog_images_post ON blog_images(blog_post_id, sort_order)',
].map((sql) => ({
  name: `index:${sql.split(' ')[2]}`,
  up: async (conn: PoolConnection) => {
    try {
      await conn.execute(sql);
    } catch (e: any) {
      // 1061 = duplicate key name, i.e. the index already exists.
      if (e.errno !== 1061) throw e;
    }
  },
}));

export const MIGRATIONS: Migration[] = [...CREATE_TABLES, ...CREATE_INDEXES];

const MIGRATION_LOCK = 'ydcs:migrations';
const MIGRATION_LOCK_TIMEOUT_SECONDS = 30;

/**
 * Applies every migration that is not yet recorded.
 *
 * A MySQL named lock (`GET_LOCK`) serialises concurrent runners. Without it,
 * two instances starting together (a rolling deploy, a restart overlap, several
 * replicas) both read an incomplete `schema_migrations` and both apply the same
 * migration. The lock is per-connection, so the whole run uses one connection.
 *
 * No transaction wraps the statements: MySQL DDL (`CREATE`/`ALTER`) implicitly
 * commits, so a transaction here would promise atomicity it cannot deliver and
 * a rollback would silently do nothing. Every migration is instead written to
 * be idempotent (IF NOT EXISTS, INSERT IGNORE, duplicate-column/index handling,
 * or a guarded UPDATE), so a retry after a mid-migration failure resumes safely.
 */
export async function runMigrations(pool: Pool): Promise<void> {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(191) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const conn = await pool.getConnection();
  let locked = false;
  try {
    const [lockRows] = await conn.execute<any[]>(
      'SELECT GET_LOCK(?, ?) AS acquired',
      [MIGRATION_LOCK, MIGRATION_LOCK_TIMEOUT_SECONDS]
    );
    locked = Number((lockRows as Array<{ acquired: number | null }>)[0]?.acquired) === 1;
    if (!locked) {
      throw new Error(`Could not acquire the migration lock within ${MIGRATION_LOCK_TIMEOUT_SECONDS}s`);
    }

    const [rows] = await conn.execute<any[]>('SELECT name FROM schema_migrations');
    const applied = new Set(rows.map((r) => r.name));

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.name)) continue;
      try {
        await migration.up(conn);
        await conn.execute('INSERT INTO schema_migrations (name) VALUES (?)', [migration.name]);
        console.log(`Migration applied: ${migration.name}`);
      } catch (err) {
        throw new Error(`Migration "${migration.name}" failed: ${(err as Error).message}`);
      }
    }
  } finally {
    if (locked) {
      try {
        await conn.execute('SELECT RELEASE_LOCK(?)', [MIGRATION_LOCK]);
      } catch {
        // Releasing the connection below drops the lock anyway.
      }
    }
    conn.release();
  }
}
