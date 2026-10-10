-- MySQL dump 10.13  Distrib 8.4.11, for Linux (x86_64)
--
-- Host: localhost    Database: audiostreaming
-- ------------------------------------------------------
-- Server version	8.4.11

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!50503 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*!40111 SET @OLD_SQL_NOTES=@@SQL_NOTES, SQL_NOTES=0 */;

--
-- Table structure for table `album_photos`
--

DROP TABLE IF EXISTS `album_photos`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `album_photos` (
  `id` varchar(36) NOT NULL,
  `album_id` varchar(36) NOT NULL,
  `caption` varchar(500) DEFAULT NULL,
  `file_name` varchar(255) NOT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_album_photos_album` (`album_id`,`sort_order`),
  CONSTRAINT `album_photos_ibfk_1` FOREIGN KEY (`album_id`) REFERENCES `albums` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `album_photos`
--

LOCK TABLES `album_photos` WRITE;
/*!40000 ALTER TABLE `album_photos` DISABLE KEYS */;
/*!40000 ALTER TABLE `album_photos` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `albums`
--

DROP TABLE IF EXISTS `albums`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `albums` (
  `id` varchar(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` varchar(500) DEFAULT NULL,
  `created_by` varchar(36) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  CONSTRAINT `albums_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `albums`
--

LOCK TABLES `albums` WRITE;
/*!40000 ALTER TABLE `albums` DISABLE KEYS */;
/*!40000 ALTER TABLE `albums` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `announcements`
--

DROP TABLE IF EXISTS `announcements`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `announcements` (
  `id` varchar(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `body` text,
  `pinned` tinyint(1) NOT NULL DEFAULT '0',
  `created_by` varchar(36) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  KEY `idx_announcements_feed` (`pinned` DESC,`created_at` DESC),
  CONSTRAINT `announcements_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `announcements`
--

LOCK TABLES `announcements` WRITE;
/*!40000 ALTER TABLE `announcements` DISABLE KEYS */;
/*!40000 ALTER TABLE `announcements` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `comments`
--

DROP TABLE IF EXISTS `comments`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `comments` (
  `id` varchar(36) NOT NULL,
  `program_id` varchar(36) NOT NULL,
  `guest_name` varchar(255) NOT NULL,
  `content` text NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_comments_program` (`program_id`),
  KEY `idx_comments_created` (`created_at` DESC),
  CONSTRAINT `comments_ibfk_1` FOREIGN KEY (`program_id`) REFERENCES `programs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `comments`
--

LOCK TABLES `comments` WRITE;
/*!40000 ALTER TABLE `comments` DISABLE KEYS */;
/*!40000 ALTER TABLE `comments` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `events`
--

DROP TABLE IF EXISTS `events`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `events` (
  `id` varchar(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text,
  `location` varchar(255) DEFAULT NULL,
  `starts_at` datetime NOT NULL,
  `ends_at` datetime DEFAULT NULL,
  `created_by` varchar(36) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  KEY `idx_events_starts` (`starts_at` DESC),
  CONSTRAINT `events_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `events`
--

LOCK TABLES `events` WRITE;
/*!40000 ALTER TABLE `events` DISABLE KEYS */;
/*!40000 ALTER TABLE `events` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `leaders`
--

DROP TABLE IF EXISTS `leaders`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `leaders` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `title` varchar(255) NOT NULL,
  `quote` varchar(500) DEFAULT NULL,
  `role_label` varchar(255) DEFAULT NULL,
  `photo` varchar(255) DEFAULT NULL,
  `sort_order` int NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_leaders_sort` (`sort_order`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `leaders`
--

LOCK TABLES `leaders` WRITE;
/*!40000 ALTER TABLE `leaders` DISABLE KEYS */;
/*!40000 ALTER TABLE `leaders` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `likes`
--

DROP TABLE IF EXISTS `likes`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `likes` (
  `id` varchar(36) NOT NULL,
  `track_id` varchar(36) NOT NULL,
  `fingerprint` varchar(255) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_like` (`track_id`,`fingerprint`),
  KEY `idx_likes_track` (`track_id`),
  KEY `idx_likes_fingerprint` (`fingerprint`),
  CONSTRAINT `likes_ibfk_1` FOREIGN KEY (`track_id`) REFERENCES `tracks` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `likes`
--

LOCK TABLES `likes` WRITE;
/*!40000 ALTER TABLE `likes` DISABLE KEYS */;
/*!40000 ALTER TABLE `likes` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `listens`
--

DROP TABLE IF EXISTS `listens`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `listens` (
  `id` varchar(36) NOT NULL,
  `track_id` varchar(36) NOT NULL,
  `program_id` varchar(36) NOT NULL,
  `fingerprint` varchar(255) DEFAULT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_listens_track` (`track_id`),
  KEY `idx_listens_program` (`program_id`),
  KEY `idx_listens_created` (`created_at` DESC),
  CONSTRAINT `listens_ibfk_1` FOREIGN KEY (`track_id`) REFERENCES `tracks` (`id`) ON DELETE CASCADE,
  CONSTRAINT `listens_ibfk_2` FOREIGN KEY (`program_id`) REFERENCES `programs` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `listens`
--

LOCK TABLES `listens` WRITE;
/*!40000 ALTER TABLE `listens` DISABLE KEYS */;
INSERT INTO `listens` VALUES ('1951e773-1ca9-4cda-9e23-b542e65b68af','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-05 18:20:40'),('1fd727ad-fc7a-48cf-b650-f5b407a62d38','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-08 15:09:53'),('220aeffe-06de-4c9d-96e3-966dc9975210','64211c1b-0e6e-4bf0-8c00-9e35f98d6234','145accfd-76f6-4d70-be3e-a180ab749cee','afef977c489547bba42c50827a7d8f00','2026-10-08 10:46:49'),('2ec8cc4e-334a-4535-8e32-8d4ec9a8fa18','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-08 13:35:44'),('2f1bc28e-fef9-465a-a127-e4d513be95b7','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','b39c4548476e4c4291560780540aa739','2026-10-08 17:24:59'),('41ec1d0b-fb44-41f2-91d2-dea28e9af0f0','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-04 18:14:55'),('46270c66-5ad2-4ad1-81a2-896b6b88029f','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-04 18:50:04'),('4d20ac06-7cea-4d98-9a13-a46297c8155d','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-08 16:09:23'),('58bead6f-6f05-4b3b-98ed-608fb1d0c1a4','64211c1b-0e6e-4bf0-8c00-9e35f98d6234','145accfd-76f6-4d70-be3e-a180ab749cee','b39c4548476e4c4291560780540aa739','2026-10-08 17:25:02'),('60864022-f98a-490b-97db-8d5de49158c8','64211c1b-0e6e-4bf0-8c00-9e35f98d6234','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-04 18:15:27'),('733ebaaa-b920-48eb-ad69-1b0906147bd3','64211c1b-0e6e-4bf0-8c00-9e35f98d6234','145accfd-76f6-4d70-be3e-a180ab749cee','b39c4548476e4c4291560780540aa739','2026-10-08 16:17:18'),('744e429b-1c6b-40fa-9cc0-fdfd14a333f0','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','b39c4548476e4c4291560780540aa739','2026-10-08 16:17:12'),('8124980f-16de-4879-ab0c-1e5f353a7290','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','2b567904d2d8453f936ba8fdfa502d35','2026-10-07 13:21:47'),('ba186c74-1b1b-459e-97dc-26f9f0400f22','64211c1b-0e6e-4bf0-8c00-9e35f98d6234','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-08 12:51:12'),('c9e7483a-8fbd-47ea-8004-cd68b36a23db','64211c1b-0e6e-4bf0-8c00-9e35f98d6234','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-08 16:09:36'),('e17d55f8-7e5c-49af-be0b-be1e4a2a4fe2','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','4c42046a77034a40ae1d3bf62700961e','2026-10-08 12:56:30'),('e25937f9-bd1c-447a-8434-2bb1d9542526','86cb3c5e-3302-4d68-8f64-6c60f4cdd011','145accfd-76f6-4d70-be3e-a180ab749cee','afef977c489547bba42c50827a7d8f00','2026-10-08 15:56:06');
/*!40000 ALTER TABLE `listens` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `programs`
--

DROP TABLE IF EXISTS `programs`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `programs` (
  `id` varchar(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `description` text,
  `cover_image` varchar(255) DEFAULT NULL,
  `created_by` varchar(36) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_programs_created` (`created_at` DESC),
  KEY `idx_programs_creator` (`created_by`),
  CONSTRAINT `programs_ibfk_1` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `programs`
--

LOCK TABLES `programs` WRITE;
/*!40000 ALTER TABLE `programs` DISABLE KEYS */;
INSERT INTO `programs` VALUES ('145accfd-76f6-4d70-be3e-a180ab749cee','Faarfannaa',NULL,'1ace8839-d7d7-4057-955b-8d69a4fceeb4.jpg','fe2af925-a5c8-4f73-8f13-ca33eeeea05b','2026-10-04 18:14:40');
/*!40000 ALTER TABLE `programs` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `schema_migrations`
--

DROP TABLE IF EXISTS `schema_migrations`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `schema_migrations` (
  `name` varchar(191) NOT NULL,
  `applied_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `schema_migrations`
--

LOCK TABLES `schema_migrations` WRITE;
/*!40000 ALTER TABLE `schema_migrations` DISABLE KEYS */;
INSERT INTO `schema_migrations` VALUES ('001_create_users','2026-10-02 12:12:27'),('002_add_users_token_version','2026-10-02 12:12:27'),('003_create_programs','2026-10-02 12:12:27'),('004_create_tracks','2026-10-02 12:12:27'),('005_create_comments','2026-10-02 12:12:27'),('006_create_likes','2026-10-02 12:12:27'),('007_create_listens','2026-10-02 12:12:27'),('008_create_leaders','2026-10-08 18:00:35'),('009_create_albums','2026-10-08 18:00:36'),('010_create_album_photos','2026-10-08 18:00:36'),('011_create_announcements','2026-10-08 18:00:36'),('012_create_events','2026-10-08 18:00:36'),('index:idx_album_photos_album','2026-10-08 18:00:36'),('index:idx_announcements_feed','2026-10-08 18:00:36'),('index:idx_comments_created','2026-10-02 12:12:27'),('index:idx_comments_program','2026-10-02 12:12:27'),('index:idx_events_starts','2026-10-08 18:00:36'),('index:idx_leaders_sort','2026-10-08 18:00:36'),('index:idx_likes_fingerprint','2026-10-02 12:12:27'),('index:idx_likes_track','2026-10-02 12:12:27'),('index:idx_listens_created','2026-10-02 12:12:27'),('index:idx_listens_program','2026-10-02 12:12:27'),('index:idx_listens_track','2026-10-02 12:12:27'),('index:idx_programs_created','2026-10-02 12:12:27'),('index:idx_programs_creator','2026-10-02 12:12:27'),('index:idx_tracks_created','2026-10-02 12:12:27'),('index:idx_tracks_program','2026-10-02 12:12:27'),('index:idx_tracks_sort','2026-10-02 12:12:27'),('index:idx_tracks_type','2026-10-02 12:12:27'),('index:idx_users_role','2026-10-02 12:12:27');
/*!40000 ALTER TABLE `schema_migrations` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `tracks`
--

DROP TABLE IF EXISTS `tracks`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `tracks` (
  `id` varchar(36) NOT NULL,
  `title` varchar(255) NOT NULL,
  `artist` varchar(255) DEFAULT NULL,
  `album` varchar(255) DEFAULT NULL,
  `duration` double DEFAULT '0',
  `file_path` varchar(255) NOT NULL,
  `program_id` varchar(36) NOT NULL,
  `track_type` enum('episode','single','mix','live') DEFAULT NULL,
  `sort_order` int DEFAULT '0',
  `created_by` varchar(36) NOT NULL,
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `created_by` (`created_by`),
  KEY `idx_tracks_program` (`program_id`),
  KEY `idx_tracks_created` (`created_at` DESC),
  KEY `idx_tracks_sort` (`program_id`,`sort_order`),
  KEY `idx_tracks_type` (`track_type`),
  CONSTRAINT `tracks_ibfk_1` FOREIGN KEY (`program_id`) REFERENCES `programs` (`id`) ON DELETE CASCADE,
  CONSTRAINT `tracks_ibfk_2` FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `tracks`
--

LOCK TABLES `tracks` WRITE;
/*!40000 ALTER TABLE `tracks` DISABLE KEYS */;
INSERT INTO `tracks` VALUES ('64211c1b-0e6e-4bf0-8c00-9e35f98d6234','AMH_TTB_0164',NULL,NULL,0,'16e31d8e-ad4b-4d80-9c11-b926f12b2600.mp3','145accfd-76f6-4d70-be3e-a180ab749cee','episode',1,'fe2af925-a5c8-4f73-8f13-ca33eeeea05b','2026-10-04 18:14:52'),('86cb3c5e-3302-4d68-8f64-6c60f4cdd011','AMH_TTB_0077',NULL,NULL,0,'3736f30b-b421-4b51-b589-77ae16a4e3bc.mp3','145accfd-76f6-4d70-be3e-a180ab749cee','episode',0,'fe2af925-a5c8-4f73-8f13-ca33eeeea05b','2026-10-04 18:14:52');
/*!40000 ALTER TABLE `tracks` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Table structure for table `users`
--

DROP TABLE IF EXISTS `users`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!50503 SET character_set_client = utf8mb4 */;
CREATE TABLE `users` (
  `id` varchar(36) NOT NULL,
  `username` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password` varchar(255) NOT NULL,
  `role` enum('super_admin','admin') NOT NULL,
  `token_version` int NOT NULL DEFAULT '0',
  `created_at` timestamp NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `username` (`username`),
  UNIQUE KEY `email` (`email`),
  KEY `idx_users_role` (`role`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
/*!40101 SET character_set_client = @saved_cs_client */;

--
-- Dumping data for table `users`
--

LOCK TABLES `users` WRITE;
/*!40000 ALTER TABLE `users` DISABLE KEYS */;
INSERT INTO `users` VALUES ('1de03ff8-f613-43d0-a511-d28130704e5b','admin','admin@audio.com','$2a$12$1I7ALDu9TFbKKxuXUrBOu.zf4UV8Faes3gRKPNS7TNKbk.jgIKJ1C','admin',1,'2026-10-01 09:55:18'),('fe2af925-a5c8-4f73-8f13-ca33eeeea05b','Elu','eladaba2022@gmail.com','$2a$12$Pn0c7CH2QhMu44X7SkitMu0sbBP3cLS5Dmp7UGFXaYy9bFSYJDFeW','super_admin',0,'2026-10-01 15:06:35');
/*!40000 ALTER TABLE `users` ENABLE KEYS */;
UNLOCK TABLES;

--
-- Dumping routines for database 'audiostreaming'
--
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*!40111 SET SQL_NOTES=@OLD_SQL_NOTES */;

-- Dump completed on 2026-10-09 17:54:05
