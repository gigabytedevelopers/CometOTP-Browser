# CometOTP-Rebrand - Two Factor (2FA) OTP Authenticator App
A rebrand for [CometOTP](https://github.com/gigabytedevelopers/CometOTP) (A powerful two-factor authentication app for Android and iOS)

<!-- [![Build Status](https://travis-ci.org/gigabytedevelopers/CometOTP.svg?branch=master)](https://travis-ci.org/gigabytedevelopers/CometOTP)
[![Current release](https://img.shields.io/github/v/release/gigabytedevelopers/CometOTP.svg?token=e52dc09de66b2a3a280415155904a2a059c8c0a3)](https://github.com/gigabytedevelopers/CometOTP/releases/download/v3.0.0/CometOTP_v3.0.0.apk) -->

![CometOTP](https://user-images.githubusercontent.com/26168869/173256170-70bab38d-29dd-426c-a82a-b8b0c241b997.png)


It implements HMAC-Based One-Time Passwords (HOTP) and Time-based One-time Passwords (TOTP) like specified in RFC 6238.  
Simply scan the QR code and login with the generated digit code(s). 

## Features:

 * Free and Open-Source
 * Requires minimal permissions
   - Camera access for QR code scanning
   - Storage access for import and export of the database
 * Encrypted storage
 * Multiple backup options:
   - Plain-text
   - Password-protected
   - OpenPGP-encrypted
 * Sleek minimalistic Material Design with a Dark and Light theme
 * Great Usability
 * Compatible with Google Authenticator

## Backups:

To keep your account information as secure as possible CometOTP only stores it in
encrypted data files. A part of the encryption key used for that is stored in the
Android KeyStore system. The advantage of this approach is that the key is kept
separate from the apps data and, as a bonus, can be backed by hardware cryptography
(if your device supports this).

However, due to that separation, backups with 3rd-party apps like Titanium Backup can not
be used with CometOTP. Such apps only backup the encrypted data files and not the encryption
key, which renders them useless.

**Please only use the internal backup functions provided by CometOTP to backup your accounts!**
**Everything else WILL result in data loss.**

### Opening the backups on your PC:

 * [OpenPGP](http://openpgp.org/): OpenPGP can be used to easily decrypt the OpenPGP-encrypted backups on your PC.

## Migration:

Check out [this](https://github.com/gigabytedevelopers/CometOTP/wiki/Migration) wiki page to learn about the different ways to migrate to CometOTP from other 2FA apps.

## Downloads:

[<img height=80 alt="Get it on Google Play" src="https://play.google.com/intl/en_us/badges/images/generic/en-play-badge.png" />](https://play.google.com/store/apps/details?id=com.gigabytedevelopersinc.app.CometOTP)
<!--[<img height=80 alt="Get it on GitHub" src="./assets/badges/get-it-on-github.png" />](https://github.com/gigabytedevelopers/CometOTP/releases)-->

**Warning**: All three versions (Google Play, F-Droid and the APKs) are not compatible (not signed by the same key)!
You will have to uninstall one to install the other, which will delete all your data.
So make sure you have a **current backup** before switching!

## Contribute:

 * **Bug reports and feature requests**: You can report bugs and request features in the [Issue tracker](https://github.com/gigabytedevelopers/CometOTP/issues) on GitHub.

#### Contributors:


## Screenshots:

[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173257552-da64851c-cc93-4a49-8e74-e8583321258e.png">](https://user-images.githubusercontent.com/26168869/173257552-da64851c-cc93-4a49-8e74-e8583321258e.png)
[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173257448-7555fb03-104d-44a8-b06f-d93abdb14ce7.png">](https://user-images.githubusercontent.com/26168869/173257448-7555fb03-104d-44a8-b06f-d93abdb14ce7.png)
[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173256771-d7985d49-0a64-4317-9ee3-1900d1f1d944.png">](https://user-images.githubusercontent.com/26168869/173256771-d7985d49-0a64-4317-9ee3-1900d1f1d944.png)
[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173256892-cd035490-266d-45c8-b113-5c25dc9a3346.png">](https://user-images.githubusercontent.com/26168869/173256892-cd035490-266d-45c8-b113-5c25dc9a3346.png)

[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173257638-b3efd2f9-a098-4b4b-8ef0-9930aad67394.png">](https://user-images.githubusercontent.com/26168869/173257638-b3efd2f9-a098-4b4b-8ef0-9930aad67394.png)
[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173257705-10f22ce1-1c64-4c29-a51f-78249bbc4436.png">](https://user-images.githubusercontent.com/26168869/173257705-10f22ce1-1c64-4c29-a51f-78249bbc4436.png)
[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173257788-1a2fccb4-3cf6-4ae5-87c3-ee71fe36dbf2.png">](https://user-images.githubusercontent.com/26168869/173257788-1a2fccb4-3cf6-4ae5-87c3-ee71fe36dbf2.png)
[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173257830-c3b7618e-260d-487c-8c6a-73d030bdbcba.png">](https://user-images.githubusercontent.com/26168869/173257830-c3b7618e-260d-487c-8c6a-73d030bdbcba.png)

[<img width=198 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173258478-57f57a45-6de0-47a6-bde6-977d2454cd5d.png">](https://user-images.githubusercontent.com/26168869/173258478-57f57a45-6de0-47a6-bde6-977d2454cd5d.png)
[<img width=198 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173259598-d46551a6-326e-44eb-8a7b-f41a422e7a14.png">](https://user-images.githubusercontent.com/26168869/173259598-d46551a6-326e-44eb-8a7b-f41a422e7a14.png)
[<img width=198 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173259052-0d68452c-fd35-4ee3-b384-1a73a51c8a9b.png">](https://user-images.githubusercontent.com/26168869/173259052-0d68452c-fd35-4ee3-b384-1a73a51c8a9b.png)
[<img width=198 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173258927-150104dc-b43b-4174-9365-b7c5ba20e0f8.png">](https://user-images.githubusercontent.com/26168869/173258927-150104dc-b43b-4174-9365-b7c5ba20e0f8.png)

[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173257883-a7224f07-3d90-4625-b51d-dfb23a045ff8.png">](https://user-images.githubusercontent.com/26168869/173257883-a7224f07-3d90-4625-b51d-dfb23a045ff8.png)
[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173256946-e0c6fd38-38df-4e8c-960d-96dec96971ab.png">](https://user-images.githubusercontent.com/26168869/173256946-e0c6fd38-38df-4e8c-960d-96dec96971ab.png)
[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173259528-d5f82689-060d-4a55-b9f5-d0de8beb1fa1.png">](https://user-images.githubusercontent.com/26168869/173259528-d5f82689-060d-4a55-b9f5-d0de8beb1fa1.png)
[<img width=200 alt="Main Activity" src="https://user-images.githubusercontent.com/26168869/173261379-7535b420-73d5-4752-8bcf-d2f629d9b64c.png">](https://user-images.githubusercontent.com/26168869/173261379-7535b420-73d5-4752-8bcf-d2f629d9b64c.png)

## Acknowledgments:
#### Open-source components used:

 * [Android CustomTabs](https://github.com/saschpe/android-customtabs)
 * [Apache Commons Codec](https://commons.apache.org/proper/commons-codec)
 * [Expandable Layout](https://github.com/AAkira/ExpandableLayout)
 * [Floating Action Button Speed Dial](https://github.com/leinardi/FloatingActionButtonSpeedDial)
 * [material-intro](https://github.com/heinrichreimer/material-intro)
 * [MaterialProgressBar](https://github.com/DreaminginCodeZH/MaterialProgressBar)
 * [OpenPGP API library](https://github.com/open-keychain/openpgp-api)
 * [ZXing Android Embedded](https://github.com/journeyapps/zxing-android-embedded)

#### Code examples used:

 * [Android-ItemTouchHelper-Demo](https://github.com/iPaulPro/Android-ItemTouchHelper-Demo/tree/master/app/src/main/java/co/paulburke/android/itemtouchhelperdemo/helper)
 * [Code Parts from Google's Android Samples](https://android.googlesource.com/platform/development/+/master/samples/Vault/src/com/example/android/vault)
 * [LetterBitmap](http://stackoverflow.com/questions/23122088/colored-boxed-with-letters-a-la-gmail)
 * [DimensionConverter](https://stackoverflow.com/questions/8343971/how-to-parse-a-dimension-string-and-convert-it-to-a-dimension-value)

#### Previously used open-source components:

 * [FABsMenu](https://github.com/jahirfiquitiva/FABsMenu)
 * [LicensesDialog](https://github.com/PSDev/LicensesDialog)

#### Previously used code examples:

 * [FloatingActionMenuAndroid](https://github.com/pmahsky/FloatingActionMenuAndroid)
