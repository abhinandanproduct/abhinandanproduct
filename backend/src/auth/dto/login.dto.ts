import { IsNotEmpty, IsString } from 'class-validator';

export class LoginDto {
  @IsString()
  @IsNotEmpty({ message: 'login is required' })
  login!: string; // username or email

  @IsString()
  @IsNotEmpty({ message: 'password is required' })
  password!: string;
}
