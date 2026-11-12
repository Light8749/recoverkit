// Privacy Policy and Terms of Service, written for how RecoverKit actually handles data.
// Operator details come from RK_OPERATOR_NAME and RK_CONTACT_EMAIL. Have a lawyer review before relying on them.
import { renderMarkdown } from './blog.js';

export const LEGAL_UPDATED = '12 November 2026';

export function operator(config) {
  const name = config.operatorName || 'RecoverKit';
  const email = config.contactEmail || '';
  return { name, email, contact: email ? `email [${email}](mailto:${email})` : `use the contact details on ${config.publicUrl}` };
}

export function privacyMarkdown(config) {
  const o = operator(config);
  const days = config.retentionDays || 395;
  return `RecoverKit is operated by **${o.name}** ("we", "us"). This policy explains what data RecoverKit handles at ${config.publicUrl}, why, and the choices you have. It is written with the Nigeria Data Protection Act 2023 (NDPA) in mind.

## Who is responsible for which data

- **Your RecoverKit account:** for the details of the businesses and people who sign up to RecoverKit, we are the data controller.
- **Your customers' data:** when a business connects its website, app, payment gateway or database, it decides what customer data RecoverKit processes and why. The business is the data controller and we process that data on its behalf, only to provide RecoverKit to that business.

## What we collect

**About account holders:** email address, business name, the kind of payments you take, a password stored as a one-way scrypt hash, sign-in sessions, and a log of important account actions (such as sign-ins and settings changes) with the IP address.

**Settings you enter:** your writing voice, payment link, payment-gateway webhook secrets, messaging-provider keys and AI-provider keys. Secrets are encrypted with AES-256-GCM.

**About a business's customers**, when the business connects RecoverKit:

- **Identifiers:** email addresses and phone numbers are turned into one-way hashes on the customer's device or the business's server before they reach us, and are hashed again on our server.
- **Contact details**, only if the business chooses to share them so RecoverKit can send its messages: email, phone and first name, stored encrypted.
- **Activity:** event types (such as signed up, started checkout, funded wallet, purchased), page paths with IDs and emails removed, amounts and times.
- **Messages:** follow-up messages drafted, approved and sent, with their status, and replies received on WhatsApp.

**We never collect** card numbers, bank details, passwords of the business's customers, or the contents of forms they fill in.

## Why we use it

- to provide RecoverKit: find customers worth following up, draft messages, send the ones the business approves, and count recovered sales
- to keep accounts secure: sign-in, password resets, rate limits and audit logs
- to send service emails: invitations, password resets and notices about messages waiting for approval

The legal bases are performing our agreement with you, our legitimate interest in running a secure service, and, for a business's customers, the lawful basis the business has for contacting them.

We do not sell personal data, and we do not use it for advertising.

## Who else is involved

Data only goes to providers that the business sets up, to do what the business asked:

- **messaging providers** it connects, such as Meta (WhatsApp Cloud API), Termii (SMS) or Resend (email), to deliver approved messages
- **an AI provider** it chooses, to draft messages. The model never receives names, emails or phone numbers.
- **payment gateways** that send signed webhooks about payments
- **our hosting provider**, which stores the service's data

We may disclose data where the law requires it.

## How long we keep it

- **Activity events:** deleted after ${days} days.
- **Account and business data:** kept while the account exists. When a business is deleted in Settings, its data is deleted.
- **Unconfirmed sign-ups:** deleted once their confirmation link expires.
- **Database backups:** kept for about 7 days.

## Your rights

You can ask to access, correct or delete your data, object to processing, or ask for a copy. Customers of a business can ask that business, which can delete a person instantly with RecoverKit's erasure feature, or ask us. Anyone can stop follow-up messages with the unsubscribe link in each message, or by replying STOP on WhatsApp. To use your rights, ${o.contact}. You can also complain to the Nigeria Data Protection Commission.

## Cookies and similar technology

The RecoverKit dashboard uses one essential cookie to keep you signed in. The website script a business installs keeps a random anonymous ID in the visitor's browser storage, and does nothing if the visitor's browser asks not to be tracked (Do Not Track or Global Privacy Control).

## Security

We use encryption for stored secrets and contact details, hashed identifiers, signed webhooks, strict browser security headers, and rate limits. No system is perfectly secure; if a breach affects you, we will tell you and the regulator as the NDPA requires.

## Children

RecoverKit is a business service and is not meant for children.

## Changes

We will update this page when our practices change, and change the date below.

*Last updated: ${LEGAL_UPDATED}.*`;
}

export function termsMarkdown(config) {
  const o = operator(config);
  return `These terms are an agreement between you (the business using RecoverKit, and the person signing up for it) and **${o.name}** ("we"), the operator of RecoverKit at ${config.publicUrl}. By creating an account or using RecoverKit, you agree to them.

## The service

RecoverKit helps a business find customers who signed up but never bought, funded a wallet but never bought, or bought once and went quiet; drafts follow-up messages; and sends the messages the business approves through the channels it connects. RecoverKit is currently **free**. We may add paid features in future, and will tell you before anything you use starts to cost money.

## Your account

- Give accurate details, keep your password and secret keys safe, and tell us if you think someone else has access.
- You are responsible for what happens in your account, including what members of your team do.
- You must be able to agree to these terms for your business.

## Your responsibilities when messaging customers

You decide who receives messages and what they say. In particular you must:

- have a lawful basis, such as consent or an existing customer relationship, to contact each person, and respect the Nigeria Data Protection Act 2023
- follow the rules of the channels you use, including Meta's WhatsApp Business policies and approved templates, and Nigerian rules on SMS (including Do-Not-Disturb preferences)
- read messages before approving them, and stop messaging anyone who opts out (RecoverKit does this automatically for unsubscribe links and STOP replies)
- not use RecoverKit for spam, fraud, harassment, illegal products, or to contact people who never dealt with your business

Messaging and AI providers bill you directly for their services under their own terms.

## Your data

Your data and your customers' data stay yours. You give us permission to process it only to run RecoverKit for you, as described in our [Privacy Policy](/privacy). You can delete your business and its data at any time in Settings.

## Acceptable use

Do not try to break, overload or get around the security of RecoverKit, access other businesses' data, or resell the service without our permission.

## Availability and changes

We work to keep RecoverKit running and secure, but we provide it **"as is"**, without guarantees that it will always be available, error-free, or that it will recover any particular amount of sales. We may change or stop features, and will give reasonable notice of major changes where we can.

## Ending

You can stop using RecoverKit and delete your business at any time. We may suspend or close accounts that break these terms or put other people at risk.

## Liability

To the extent the law allows, we are not liable for indirect or consequential losses, lost profits or lost data. Because the service is free, our total liability to you is limited to ₦50,000.

## Law

These terms are governed by the laws of the Federal Republic of Nigeria.

## Contact

Questions about these terms? ${o.contact[0].toUpperCase()}${o.contact.slice(1)}.

*Last updated: ${LEGAL_UPDATED}.*`;
}

export const renderLegal = (md) => renderMarkdown(md);
