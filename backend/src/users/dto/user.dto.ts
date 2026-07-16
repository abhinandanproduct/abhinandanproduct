import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { UserRole, ActiveStatus } from '@prisma/client';

export class CreateUserDto {
  @IsString() @MinLength(2) @MaxLength(60) username!: string;
  @IsEmail() @MaxLength(150) email!: string;
  @IsString() @MinLength(2) @MaxLength(150) fullName!: string;
  /** Initial password — must be ≥ 6 chars. Operator can reset later. */
  @IsString() @MinLength(6) @MaxLength(128) password!: string;
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
  @IsOptional() @IsEnum(ActiveStatus) status?: ActiveStatus;
}

export class UpdateUserDto {
  // username is locked once created — change-username flows surprise people
  // (audit log entries point at the old name, JWTs in flight still claim
  // it, etc.). Editable fields are name/email/role/status. Password reset
  // is its own endpoint so it can be logged separately.
  @IsOptional() @IsEmail() @MaxLength(150) email?: string;
  @IsOptional() @IsString() @MinLength(2) @MaxLength(150) fullName?: string;
  @IsOptional() @IsEnum(UserRole) role?: UserRole;
  @IsOptional() @IsEnum(ActiveStatus) status?: ActiveStatus;
}

export class ResetPasswordDto {
  @IsString() @MinLength(6) @MaxLength(128) password!: string;
}
